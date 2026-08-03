// 読み取り専用のドライラン。bookingsへの書き込みは一切行わない。
//
// JUNさんがレビュー・承認した対象リスト(CSV: ref_no一覧、187件)について、A版
// (2025/02/20版、Access移行前の実日付)のin_dateへ復旧する場合の「現在値→復旧後の値」を
// 一覧化する。復旧後の値は、生CSVの日付列(表記ゆれがあり誤読のリスクがある)ではなく、
// 既に検証済みの scripts/data/access_booking_reconcile.json の A.出発日(既存の
// generate_access_booking_reconcile.js の normalizeDate()で正規化済み)を正とする。
// CSVは対象ref_noの一覧としてのみ使用する。
//
// 実行方法: node scripts/dryrun_restore_in_date.js [--csv <path>]

const fs = require('fs');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

function parseArgs(argv) {
  const args = { csv: 'C:\\Users\\jryus\\Downloads\\in_date_regression_review_list.csv' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--csv') args.csv = argv[++i];
  }
  return args;
}

// 簡易CSVパーサ(ダブルクォート内カンマに対応)。このCSVは全列とも引用符なしのシンプルな形式。
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '');
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h.trim()] = (cols[i] || '').trim(); });
    return row;
  });
}

async function sbGet(pathAndQuery) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase GET ${pathAndQuery}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvText = fs.readFileSync(args.csv, 'utf8');
  const rows = parseCsv(csvText);
  console.log('CSV対象件数:', rows.length);

  const reconcile = JSON.parse(fs.readFileSync('scripts/data/access_booking_reconcile.json', 'utf8'));
  const reconcileById = new Map(reconcile.map((r) => [r.id, r]));

  // 現在のbookings.in_dateを一括取得
  const refNos = rows.map((r) => r.ref_no);
  const currentByRef = new Map();
  const chunkSize = 200;
  for (let i = 0; i < refNos.length; i += chunkSize) {
    const chunk = refNos.slice(i, i + chunkSize);
    const inList = chunk.map((r) => `"${encodeURIComponent(r)}"`).join(',');
    const data = await sbGet(`bookings?select=id,ref_no,in_date,agent_name,tour_name&ref_no=in.(${inList})`);
    data.forEach((row) => currentByRef.set(row.ref_no, row));
  }
  console.log('現在のbookingsで見つかった件数:', currentByRef.size, '/', refNos.length);

  const plan = [];
  const notFoundInBookings = [];
  const noReconcileA = [];
  const alreadyCorrect = [];

  for (const row of rows) {
    const refNo = row.ref_no;
    const current = currentByRef.get(refNo);
    if (!current) {
      notFoundInBookings.push({ ref_no: refNo, csv_A: row['A版_出発日(移行前実日付)'] });
      continue;
    }
    const rec = reconcileById.get(refNo);
    const targetInDate = rec && rec.A ? rec.A['出発日'] : undefined;
    if (!targetInDate) {
      noReconcileA.push({ ref_no: refNo, current_in_date: current.in_date, csv_A: row['A版_出発日(移行前実日付)'] });
      continue;
    }
    if (current.in_date === targetInDate) {
      alreadyCorrect.push({ ref_no: refNo, in_date: current.in_date });
      continue;
    }
    plan.push({
      id: current.id,
      ref_no: refNo,
      agent_name: current.agent_name || '',
      tour_name: current.tour_name || '',
      current_in_date: current.in_date,
      restore_to_in_date: targetInDate,
    });
  }

  console.log('\n=== ドライラン結果: 復旧対象(現在値≠復旧後の値) ===');
  console.log('件数:', plan.length);
  console.log(JSON.stringify(plan, null, 2));

  console.log('\n=== 現在のbookingsに見つからないref_no ===');
  console.log('件数:', notFoundInBookings.length);
  console.log(JSON.stringify(notFoundInBookings, null, 2));

  console.log('\n=== access_booking_reconcile.jsonにA.出発日が無いref_no(要個別確認) ===');
  console.log('件数:', noReconcileA.length);
  console.log(JSON.stringify(noReconcileA, null, 2));

  console.log('\n=== 既に復旧済み(現在値=復旧後の値。対応不要) ===');
  console.log('件数:', alreadyCorrect.length);
  console.log(JSON.stringify(alreadyCorrect, null, 2));

  const outPath = 'scripts/data/dryrun_restore_in_date_result.json';
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        csv_total: rows.length,
        plan,
        not_found_in_bookings: notFoundInBookings,
        no_reconcile_a: noReconcileA,
        already_correct: alreadyCorrect,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log('\n結果を保存しました:', outPath);

  // CSV出力(復旧計画)
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const cols = ['ref_no', 'agent_name', 'tour_name', 'current_in_date', 'restore_to_in_date'];
  const planCsv = ['\uFEFF' + cols.join(','), ...plan.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
  fs.writeFileSync('scripts/data/dryrun_restore_in_date_plan.csv', planCsv, 'utf8');
  console.log('復旧計画CSVを保存しました: scripts/data/dryrun_restore_in_date_plan.csv');
}

main().catch((e) => {
  console.error('エラー:', e);
  process.exit(1);
});
