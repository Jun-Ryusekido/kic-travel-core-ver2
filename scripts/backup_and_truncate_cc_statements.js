// credit_card_statementsテーブルの全件削除(テストデータ・手書きコード誤読データの
// クリーンアップ)。実行前に必ず全件をタイムスタンプ付きJSONへバックアップし、
// バックアップの書き込み・読み戻し確認が済むまでDELETEは一切実行しない
// (apply_access_booking_merge.js等と同様の安全策パターン)。
//
// credit_card_statementsは他テーブルから参照されていない独立テーブルであることを
// リポジトリ全体をgrepして確認済み(FK参照・関連テーブルなし)。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/backup_and_truncate_cc_statements.js [--yes]
//   --yes を付けない場合、対象件数を表示し、確認プロンプトで一時停止する。

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABLE = 'credit_card_statements';

function parseArgs(argv) {
  return { yes: argv.includes('--yes') };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function sbSelectAll() {
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?select=*&order=id.asc`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`SELECT ${TABLE} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbDeleteAll() {
  // idは常に存在するnot-null列のため、id=not.is.nullで「全件」を安全に指定する
  // (フィルタなしのDELETEはPostgREST側で拒否されるための対策)。
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=not.is.null`, {
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
    console.error(`${TABLE}への全件削除にはservice_roleキーが必須です(anonキーでは実行できません)。`);
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));

  console.log(`${TABLE} の全件を読み取り中...`);
  const rows = await sbSelectAll();
  console.log(`対象件数: ${rows.length}件`);

  if (rows.length === 0) {
    console.log('削除対象がありません。処理を終了します。');
    return;
  }

  if (!args.yes) {
    const ans = await ask(`\n上記${rows.length}件を本番${TABLE}から全件削除します。よろしいですか? (yes と入力): `);
    if (ans.trim() !== 'yes') {
      console.log('中止しました。削除は行っていません。');
      return;
    }
  }

  // ── 1. バックアップをDELETE実行前に必ず保存する ──────────────────────
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const backupDir = path.resolve('scripts/data');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `cc_statements_backup_${timestamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2), 'utf8');

  // バックアップが実際に書き込まれ、読み戻せることを確認してからでないと先に進まない。
  const reread = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!Array.isArray(reread) || reread.length !== rows.length) {
    console.error(`バックアップの書き込み確認に失敗しました(${backupPath})。削除を中止します。`);
    process.exit(1);
  }
  console.log(`バックアップを保存しました: ${backupPath} (${rows.length}件)`);

  // ── 2. 全件削除 ──────────────────────
  await sbDeleteAll();

  // ── 3. 削除後、実際にSupabaseから再取得し0件であることを確認する ──────────
  const afterRows = await sbSelectAll();

  console.log('=== 実行結果 ===');
  console.log(`バックアップファイル: ${backupPath}`);
  console.log(`バックアップ件数: ${rows.length}`);
  console.log(`削除後の件数: ${afterRows.length}`);
  if (afterRows.length === 0) {
    console.log('全件削除を確認しました。');
  } else {
    console.log(`⚠ 削除後も${afterRows.length}件が残っています。手動で確認してください。`);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error('エラーが発生しました:', e.message);
    process.exit(1);
  });
}
