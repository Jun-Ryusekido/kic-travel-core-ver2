// in_date復旧の本番実行(apply_access_booking_merge.jsと同様の安全策)。
//
// scripts/data/dryrun_restore_in_date_result.json の plan(現在値≠復旧後の値、187件中177件)を
// 対象に、bookings.in_dateのみをUPDATEする。他の列は一切変更しない。
//
// 安全策:
//   1. UPDATEを1件でも実行する前に、対象全件の「変更前in_date」をタイムスタンプ付き
//      ローカルJSON(scripts/data/restore_in_date_backup_<実行日時>.json)へ保存する。
//   2. 1件failした時点で即座に処理を停止する(以降のレコードには一切手を付けない)。
//   3. 実行後、実際にSupabaseから全件を再取得し、復旧後の値と一致しているか自己検証する。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/apply_restore_in_date.js [--yes]
//   --yesを付けない場合、対象件数を表示して確認プロンプトで一時停止する。

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function sbUpdateById(id, fields) {
  const r = await fetch(`${SB_URL}/rest/v1/bookings?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`UPDATE bookings id=${id} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbGet(pathAndQuery) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase GET ${pathAndQuery}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function main() {
  if (!SERVICE_KEY) {
    console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
    process.exit(1);
  }
  const yes = process.argv.includes('--yes');

  const dryrun = JSON.parse(fs.readFileSync('scripts/data/dryrun_restore_in_date_result.json', 'utf8'));
  const plan = dryrun.plan;
  console.log(`対象件数: ${plan.length}件`);
  console.log('内訳(先頭5件):');
  plan.slice(0, 5).forEach((p) => console.log(`  ${p.ref_no}: ${p.current_in_date} → ${p.restore_to_in_date}`));

  if (!yes) {
    const ans = await ask(`\n${plan.length}件のin_dateをUPDATEします。よろしいですか？ (yes/no): `);
    if (ans.trim().toLowerCase() !== 'yes') {
      console.log('中止しました。');
      return;
    }
  }

  // バックアップ(変更前in_date)を先に保存
  const ts = new Date();
  const tsStr = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;
  const backupPath = path.resolve(`scripts/data/restore_in_date_backup_${tsStr}.json`);
  const backup = plan.map((p) => ({
    id: p.id,
    ref_no: p.ref_no,
    before: { in_date: p.current_in_date },
    after: { in_date: p.restore_to_in_date },
  }));
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`\nバックアップを保存しました: ${backupPath}`);
  // 読み戻し確認
  const reread = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (reread.length !== plan.length) {
    console.error('バックアップの読み戻し確認に失敗しました。処理を中止します。');
    process.exit(1);
  }
  console.log('バックアップの読み戻し確認OK。UPDATEを開始します。\n');

  const succeeded = [];
  const failed = [];
  for (const p of plan) {
    try {
      await sbUpdateById(p.id, { in_date: p.restore_to_in_date });
      succeeded.push(p);
      process.stdout.write('.');
    } catch (e) {
      failed.push({ ref_no: p.ref_no, id: p.id, error: e.message });
      console.error(`\n失敗: ${p.ref_no} (${p.id}): ${e.message}`);
      break; // 1件failした時点で即座に停止
    }
  }
  console.log(`\n\nUPDATE完了: 成功 ${succeeded.length}件 / 失敗 ${failed.length}件 / 未実行 ${plan.length - succeeded.length - failed.length}件`);

  if (failed.length) {
    console.log('\n=== 失敗詳細 ===');
    console.log(JSON.stringify(failed, null, 2));
  }

  // 自己検証: 成功したものを実際に再取得し、復旧後の値と一致しているか確認
  console.log('\n再取得による検証中...');
  const verifyResults = [];
  const chunkSize = 200;
  const succeededIds = succeeded.map((p) => p.id);
  const currentById = new Map();
  for (let i = 0; i < succeededIds.length; i += chunkSize) {
    const chunk = succeededIds.slice(i, i + chunkSize);
    const inList = chunk.map((id) => `"${id}"`).join(',');
    const rows = await sbGet(`bookings?select=id,ref_no,in_date&id=in.(${inList})`);
    rows.forEach((r) => currentById.set(r.id, r));
  }
  let verifyOk = 0;
  let verifyMismatch = [];
  for (const p of succeeded) {
    const cur = currentById.get(p.id);
    if (!cur) {
      verifyMismatch.push({ ref_no: p.ref_no, id: p.id, reason: '再取得できず' });
      continue;
    }
    if (cur.in_date === p.restore_to_in_date) {
      verifyOk++;
    } else {
      verifyMismatch.push({ ref_no: p.ref_no, id: p.id, expected: p.restore_to_in_date, actual: cur.in_date });
    }
  }
  console.log(`検証OK: ${verifyOk} / ${succeeded.length}`);
  if (verifyMismatch.length) {
    console.log('\n=== 検証で不一致だったもの ===');
    console.log(JSON.stringify(verifyMismatch, null, 2));
  }

  const resultPath = 'scripts/data/restore_in_date_apply_result.json';
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        backup_path: backupPath,
        total: plan.length,
        succeeded_count: succeeded.length,
        failed_count: failed.length,
        not_executed_count: plan.length - succeeded.length - failed.length,
        failed,
        verify_ok_count: verifyOk,
        verify_mismatch: verifyMismatch,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`\n結果を保存しました: ${resultPath}`);
}

main().catch((e) => {
  console.error('エラー:', e);
  process.exit(1);
});
