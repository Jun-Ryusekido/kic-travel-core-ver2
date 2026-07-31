// scripts/apply_access_booking_merge.js が書き込み前に保存したバックアップJSONを使って、
// bookingsの反映対象列だけを変更前の値に戻す(他の列には一切触れない)。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/rollback_access_booking_merge.js --backup <path> [--yes]

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { SB_URL } = require('./dry_run_access_booking_merge');

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function parseArgs(argv) {
  const args = { backup: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--backup') args.backup = argv[++i];
    if (argv[i] === '--yes') args.yes = true;
  }
  return args;
}

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

async function sbGetById(id, columns) {
  const r = await fetch(`${SB_URL}/rest/v1/bookings?select=id,${columns.join(',')}&id=eq.${encodeURIComponent(id)}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`GET bookings id=${id} failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows[0] || null;
}

function normVal(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

async function main() {
  if (!SERVICE_KEY) {
    console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args.backup) {
    console.error('--backup <バックアップJSONのパス> を指定してください。');
    process.exit(1);
  }
  const backupPath = path.resolve(args.backup);
  if (!fs.existsSync(backupPath)) {
    console.error(`バックアップファイルが見つかりません: ${backupPath}`);
    process.exit(1);
  }
  const backupRecords = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

  console.log(`=== ロールバック対象: ${backupRecords.length}件(${backupPath}) ===`);
  backupRecords.slice(0, 10).forEach((r) => {
    console.log(`  ref_no=${r.ref_no} 戻す列: ${Object.keys(r.before).join(', ')}`);
  });
  if (backupRecords.length > 10) console.log(`  ...ほか${backupRecords.length - 10}件`);

  if (!args.yes) {
    const ans = await ask(`\n上記の内容で本番bookingsを変更前の値に戻します。よろしいですか? (yes と入力): `);
    if (ans.trim() !== 'yes') {
      console.log('中止しました。書き込みは行っていません。');
      return;
    }
  }

  let successCount = 0;
  let failedRefNo = null;
  let failedError = null;

  for (const r of backupRecords) {
    try {
      await sbUpdateById(r.id, r.before);
      successCount++;
    } catch (e) {
      failedRefNo = r.ref_no;
      failedError = e;
      break;
    }
  }

  console.log('=== 復元結果 ===');
  console.log(`処理対象件数: ${backupRecords.length}`);
  console.log(`成功件数: ${successCount}`);
  console.log(`失敗件数: ${failedRefNo ? 1 : 0}`);
  if (failedRefNo) {
    console.log(`ref_no=${failedRefNo} で失敗したため処理を停止しました: ${failedError.message}`);
    console.log('残りのレコードは未処理です。同じコマンドを再実行すると、既に戻った分も含めて再度実行されます(冪等)。');
    return;
  }

  // 復元後、実際に変更前の値と一致したか再取得して検証する
  console.log('復元後の値を再取得して検証しています...');
  let mismatchCount = 0;
  for (const r of backupRecords) {
    const columns = Object.keys(r.before);
    const current = await sbGetById(r.id, columns);
    if (!current) {
      console.warn(`警告: ref_no=${r.ref_no} (id=${r.id}) が見つかりませんでした`);
      mismatchCount++;
      continue;
    }
    const mismatched = columns.filter((col) => normVal(current[col]) !== normVal(r.before[col]));
    if (mismatched.length) {
      console.warn(`警告: ref_no=${r.ref_no} で復元後の値が一致しません: ${mismatched.join(', ')}`);
      mismatchCount++;
    }
  }
  console.log(mismatchCount ? `検証完了: 不一致 ${mismatchCount}件` : '検証完了: 全件一致しました。');
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error('エラー:', e);
    process.exit(1);
  });
}
