// booking_costsテーブルから、booking_idがNULL(どの予約にも紐づいていない)かつ
// memoに「伝票より反映」を含む孤立行を削除する(F7調査で発見。ガイド精算からの
// 仕入明細反映(reflectVoucherToCost)が何らかの理由でbooking_idを伴わずに
// 挿入されてしまったケースと見られる。本番で3件・合計-¥38,191を確認済み)。
//
// 実行前に必ず対象行の全カラムをタイムスタンプ付きJSONへバックアップし、
// バックアップの書き込み・読み戻し確認が済むまでDELETEは一切実行しない
// (scripts/backup_and_truncate_cc_statements.js等と同様の安全策パターン)。
//
// 対象条件は booking_id is null かつ memo に「伝票より反映」を含む行のみに厳密に
// 限定する(他の孤立booking_costs行や、booking_idがある「伝票より反映」行には
// 一切触れない)。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/backup_and_delete_orphan_booking_costs.js [--yes]
//   --yes を付けない場合、対象件数を表示し、確認プロンプトで一時停止する。

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABLE = 'booking_costs';
// PostgRESTのilikeで「伝票より反映」を含む行を絞り込む(前後に%を付けた部分一致)。
// 手打ちのパーセントエンコード文字列は誤りに気づきにくいため、必ずencodeURIComponentで
// 生成する(ilikeの値自体は「*text*」の形。PostgRESTのilike演算子は*をワイルドカードとして
// 受け付ける)。
const MEMO_FILTER = `memo=ilike.${encodeURIComponent('*伝票より反映*')}`;

function parseArgs(argv) {
  return { yes: argv.includes('--yes') };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function sbSelectTargets() {
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?select=*&booking_id=is.null&${MEMO_FILTER}&order=id.asc`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`SELECT ${TABLE} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbDeleteByIds(ids) {
  const idList = ids.map(encodeURIComponent).join(',');
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=in.(${idList})`, {
    method: 'DELETE',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'return=minimal',
    },
  });
  if (!r.ok) throw new Error(`DELETE ${TABLE} failed: ${r.status} ${await r.text()}`);
}

async function main() {
  if (!SERVICE_KEY) {
    console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
    console.error(`${TABLE}への削除にはservice_roleキーが必須です(anonキーでは実行できません)。`);
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));

  console.log(`${TABLE} の孤立行(booking_id is null かつ memoに「伝票より反映」を含む)を読み取り中...`);
  const rows = await sbSelectTargets();
  console.log(`対象件数: ${rows.length}件`);
  rows.forEach((r) => {
    console.log(`  id=${r.id} item_name=${r.item_name} amount=${r.amount} memo=${r.memo}`);
  });

  if (rows.length === 0) {
    console.log('削除対象がありません。処理を終了します。');
    return;
  }

  if (!args.yes) {
    const ans = await ask(`\n上記${rows.length}件を本番${TABLE}から削除します。よろしいですか? (yes と入力): `);
    if (ans.trim() !== 'yes') {
      console.log('中止しました。削除は行っていません。');
      return;
    }
  }

  // ── 1. バックアップをDELETE実行前に必ず保存する ──────────────────────
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const backupDir = path.resolve('scripts/data');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `orphan_booking_costs_backup_${timestamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2), 'utf8');

  // バックアップが実際に書き込まれ、読み戻せることを確認してからでないと先に進まない。
  const reread = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!Array.isArray(reread) || reread.length !== rows.length) {
    console.error(`バックアップの書き込み確認に失敗しました(${backupPath})。削除を中止します。`);
    process.exit(1);
  }
  console.log(`バックアップを保存しました: ${backupPath} (${rows.length}件)`);

  // ── 2. 対象idのみ削除(他の孤立行・他の伝票より反映行には触れない) ──────
  await sbDeleteByIds(rows.map((r) => r.id));

  // ── 3. 削除後、実際にSupabaseから再取得し、対象条件に一致する行が0件であることを確認 ──
  const afterRows = await sbSelectTargets();

  console.log('=== 実行結果 ===');
  console.log(`バックアップファイル: ${backupPath}`);
  console.log(`バックアップ件数: ${rows.length}`);
  console.log(`削除後の該当件数: ${afterRows.length}`);
  if (afterRows.length === 0) {
    console.log('対象行の削除を確認しました。');
  } else {
    console.log(`⚠ 削除後も${afterRows.length}件が該当条件に一致しています。手動で確認してください。`);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error('エラーが発生しました:', e.message);
    process.exit(1);
  });
}
