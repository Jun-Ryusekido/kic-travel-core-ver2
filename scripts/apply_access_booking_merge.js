// KIC_INBOUND(旧Accessシステム)の予約台帳データ統合(実際の書き込み)。
//
// 実行前提: 必ず scripts/dry_run_access_booking_merge.js の結果をJUNさんが確認し、
// 承認を得てから実行すること。実行にはservice_roleキーが必要(anonキーではbookingsへの
// 書き込みができない、フェーズ3のセキュリティ移行済みのため)。
//
// 安全策:
//   1. 書き込み対象レコードの「変更前の値」(反映対象列のみ)を、UPDATEを1件でも実行する前に
//      必ずローカルJSON(scripts/data/access_booking_merge_backup_<実行日時>.json)へ保存する。
//   2. バックアップの書き込み・読み戻し確認が済むまでは、UPDATEは一切実行しない。
//   3. 1件failした時点で即座に処理を停止する(以降のレコードには一切手を付けない)。
//      それまでに成功した分は同じバックアップファイルで scripts/rollback_access_booking_merge.js
//      から復元できる。
//   4. 処理件数・成功件数・失敗件数を必ずログ出力する。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/apply_access_booking_merge.js [--input <path>] [--yes]
//   --yes を付けない場合、実行前に対象件数・列内訳を表示し、確認プロンプトで一時停止する。

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { findChangedRecords, REFLECT_COLUMNS, SB_URL } = require('./dry_run_access_booking_merge');

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function parseArgs(argv) {
  const args = { input: 'scripts/data/access_booking_reconcile.json', yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') args.input = argv[++i];
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

async function main() {
  if (!SERVICE_KEY) {
    console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
    console.error('bookingsへの書き込みはservice_roleキーが必須です(anonキーでは書き込めません)。');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`入力JSONが見つかりません: ${inputPath}`);
    process.exit(1);
  }
  const records = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  console.log('対象レコードを判定中(読み取りのみ)...');
  const { changed } = await findChangedRecords(records);

  if (!changed.length) {
    console.log('変更が発生するレコードはありませんでした。書き込みは行いません。');
    return;
  }

  const byColumn = {};
  changed.forEach((r) => r.changes.forEach((c) => { byColumn[c.column] = (byColumn[c.column] || 0) + 1; }));

  console.log(`=== 書き込み対象: ${changed.length}件 ===`);
  console.log('列ごとの変更件数内訳:');
  Object.entries(byColumn).sort((a, b) => b[1] - a[1]).forEach(([col, n]) => console.log(`  ${col}: ${n}`));

  if (!args.yes) {
    const ans = await ask(`\n上記の内容で本番bookingsへ書き込みます。よろしいですか? (yes と入力): `);
    if (ans.trim() !== 'yes') {
      console.log('中止しました。書き込みは行っていません。');
      return;
    }
  }

  // ── 1. バックアップをUPDATE実行前に必ず保存する ──────────────────────
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const backupDir = path.resolve('scripts/data');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `access_booking_merge_backup_${timestamp}.json`);

  const backupRecords = changed.map((r) => {
    const before = {};
    REFLECT_COLUMNS.forEach((col) => {
      const c = r.changes.find((x) => x.column === col);
      before[col] = c ? c.before : undefined;
    });
    // 変更されない列(undefined)はバックアップに含めない(=ロールバック時にも触らない)
    Object.keys(before).forEach((k) => { if (before[k] === undefined) delete before[k]; });
    return { id: r.bookingId, ref_no: r.refNo, before };
  });
  fs.writeFileSync(backupPath, JSON.stringify(backupRecords, null, 2), 'utf8');

  // バックアップが実際に書き込まれ、読み戻せることを確認してからでないと先に進まない。
  const reread = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!Array.isArray(reread) || reread.length !== backupRecords.length) {
    console.error(`バックアップの書き込み確認に失敗しました(${backupPath})。書き込みを中止します。`);
    process.exit(1);
  }
  console.log(`バックアップを保存しました: ${backupPath}`);

  // ── 2. 1件ずつUPDATE。失敗したら即座に停止する ──────────────────────
  let successCount = 0;
  let failedRefNo = null;
  let failedError = null;

  for (const r of changed) {
    const fields = {};
    r.changes.forEach((c) => { fields[c.column] = c.after; });
    try {
      await sbUpdateById(r.bookingId, fields);
      successCount++;
    } catch (e) {
      failedRefNo = r.refNo;
      failedError = e;
      break;
    }
  }

  console.log('=== 実行結果 ===');
  console.log(`処理対象件数: ${changed.length}`);
  console.log(`成功件数: ${successCount}`);
  console.log(`失敗件数: ${failedRefNo ? 1 : 0}`);
  if (failedRefNo) {
    console.log(`ref_no=${failedRefNo} で失敗したため処理を停止しました: ${failedError.message}`);
    console.log(`成功した${successCount}件を元に戻す場合は、以下のコマンドで復元できます:`);
    console.log(`  node scripts/rollback_access_booking_merge.js --backup ${backupPath}`);
  } else {
    console.log('全件成功しました。');
  }
  console.log(`バックアップファイル: ${backupPath}`);
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error('エラー:', e);
    process.exit(1);
  });
}
