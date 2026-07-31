// KIC_INBOUND(旧Accessシステム)の予約台帳データ統合: 本番bookingsに存在しない新規候補
// (scripts/data/access_booking_merge_dryrun_new_candidates.csv、verify_new_candidates.jsの
// 検証でmatch_status='true_new'と確認済みのもの)を実際にINSERTする。
//
// apply_access_booking_merge.jsと同じ安全設計:
//   1. 既定はdry-run(実際のINSERTは行わない)。本番書き込みには明示的に --yes が必要。
//   2. --yesありでも、INSERT実行前に必ずタイムスタンプ付きバックアップJSON
//      (scripts/data/access_new_bookings_backup_<実行日時>.json、insert対象の全カラム内容)を
//      保存してから書き込む。
//   3. --yesありでも、実際のINSERT直前に対話式のy/n確認を必ず挟む(スキップ不可)。
//   4. INSERT対象のref_noが1件でも本番に既に存在する場合、書き込み開始前にその場で
//      全体を中断する(部分書き込みをしない。verify_new_candidates.jsの結果と矛盾するため)。
//   5. 1件ずつINSERTし、1件failした時点で即座に停止する(以降は一切書き込まない)。
//      それまでに成功した分は、削除すべきIDのリストをその場で表示する。
//   6. INSERT後、実際にSupabaseから該当ref_noを再取得し、本当に反映されたか自己検証する。
//
// カラムマッピング: dry_run_access_booking_merge.js の REFLECT_COLUMNS / computeFinalValue を
// そのままrequireして使う(apply_access_booking_merge.jsと同じロジック)。現在値が存在しない
// (=新規)ため、current=nullとして「Aの値→Bの値(Bが勝つ)」の2段階決定をそのまま適用する。
//
// 注記: add_access_migration_columns_to_bookings.sql には「移行元フラグ」に相当する列は
// 現時点で存在しない。将来そのような列が追加された場合は、下記INSERT_DEFAULTS付近に
// 追記すること(今回は何もセットしない)。
//
// 実行方法:
//   node scripts/insert_new_access_bookings.js                    (既定: dry-run、書き込みなし)
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/insert_new_access_bookings.js --yes  (本番実行)
//   任意で --candidates <path> / --verify <path> / --reconcile <path> でソースファイルを変更可。

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { REFLECT_COLUMNS, computeFinalValue, SB_URL } = require('./dry_run_access_booking_merge');

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
// dry-run(読み取りのみ)は書き込み権限が無いanonキーでも動作させたいため、
// SERVICE_KEYが無い場合はanonキーにフォールバックする(--yes時はSERVICE_KEY必須、後述)。
const READ_KEY = SERVICE_KEY || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

// INSERT時に反映対象外の列へ設定する既定値(New Booking画面のsaveBooking()と同じ規約)。
const INSERT_DEFAULTS = {
  staff_in_charge: null,
  in_date: null,
  out_date: null,
  pax_adult: 0,
  pax_child: 0,
  pax_infant: 0,
  agent_name: '',
  tour_name: '',
  country: null,
  booking_type: null,
  status: 'open',
};

function parseArgs(argv) {
  const args = {
    candidates: 'scripts/data/access_booking_merge_dryrun_new_candidates.csv',
    verify: 'scripts/data/verify_new_candidates_result.csv',
    reconcile: 'scripts/data/access_booking_reconcile.json',
    review: 'scripts/data/needs_manual_review.csv',
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--candidates') args.candidates = argv[++i];
    if (argv[i] === '--verify') args.verify = argv[++i];
    if (argv[i] === '--reconcile') args.reconcile = argv[++i];
    if (argv[i] === '--review') args.review = argv[++i];
    if (argv[i] === '--yes') args.yes = true;
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function sbGet(query, key) {
  const r = await fetch(`${SB_URL}/rest/v1/${query}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`GET ${query} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbInsertOne(row) {
  const r = await fetch(`${SB_URL}/rest/v1/bookings`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`INSERT bookings ref_no=${row.ref_no} failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows[0];
}

// URLの長さ制限を避けるため、ref_noのin.()検索をチャンク分割して行う。
async function sbFindExistingRefNos(refNos, key) {
  const CHUNK = 80;
  const found = [];
  for (let i = 0; i < refNos.length; i += CHUNK) {
    const chunk = refNos.slice(i, i + CHUNK);
    const list = chunk.map((r) => encodeURIComponent(r)).join(',');
    const rows = await sbGet(`bookings?select=id,ref_no&ref_no=in.(${list})`, key);
    found.push(...rows);
  }
  return found;
}

// reconcile.jsonの1レコード(A/B)から、bookingsへのINSERT用の1行を組み立てる。
// current=null(新規のため既存値が無い)としてA→Bの2段階決定ロジックをそのまま適用し、
// 反映対象外(undefined)の列にはINSERT_DEFAULTSの既定値を使う。
function buildInsertRow(refNo, reconcileRecord) {
  const row = { ref_no: refNo };
  for (const col of REFLECT_COLUMNS) {
    const final = computeFinalValue(col, null, reconcileRecord);
    row[col] = final === undefined || final === null || final === '' ? INSERT_DEFAULTS[col] : final;
  }
  // pax_adult/pax_child/pax_infantは数値化(Access側は文字列で来ることがある)
  row.pax_adult = Number(row.pax_adult) || 0;
  row.pax_child = Number(row.pax_child) || 0;
  row.pax_infant = Number(row.pax_infant) || 0;
  row.pax = row.pax_adult + row.pax_child + row.pax_infant;
  row.gross_sales = 0;
  row.gross_cost = 0;
  return row;
}

function pickSampleIndices(n, count) {
  if (n <= 15) return Array.from({ length: n }, (_, i) => i);
  const shown = new Set();
  const first = Array.from({ length: 5 }, (_, i) => i);
  const last = Array.from({ length: 5 }, (_, i) => n - 5 + i);
  first.concat(last).forEach((i) => shown.add(i));
  const randomPicks = [];
  const pool = Array.from({ length: n }, (_, i) => i).filter((i) => !shown.has(i));
  for (let k = 0; k < 5 && pool.length; k++) {
    const idx = Math.floor(Math.random() * pool.length);
    randomPicks.push(pool.splice(idx, 1)[0]);
  }
  return [...new Set([...first, ...randomPicks, ...last])].sort((a, b) => a - b);
}

function printRowSummary(label, row) {
  console.log(`--- ${label}: ${row.ref_no} ---`);
  console.log(`  agent_name : ${row.agent_name}`);
  console.log(`  tour_name  : ${row.tour_name}`);
  console.log(`  country    : ${row.country}`);
  console.log(`  booking_type: ${row.booking_type}`);
  console.log(`  in_date    : ${row.in_date}  out_date: ${row.out_date}`);
  console.log(`  pax        : ADT ${row.pax_adult} / CHD ${row.pax_child} / INF ${row.pax_infant} (計 ${row.pax})`);
  console.log(`  status     : ${row.status}`);
  console.log(`  staff_in_charge: ${row.staff_in_charge}`);
}

function printSummary(rows) {
  const dates = rows.map((r) => r.in_date).filter(Boolean).sort();
  const withTourName = rows.filter((r) => r.tour_name).length;
  const withAgent = rows.filter((r) => r.agent_name).length;
  const withCountry = rows.filter((r) => r.country).length;
  const byStatus = {};
  rows.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  console.log('\n=== 全件サマリー ===');
  console.log(`件数: ${rows.length}`);
  console.log(`ref_no一覧: ${rows.map((r) => r.ref_no).join(', ')}`);
  console.log(`in_dateの範囲: ${dates[0] || '(なし)'} 〜 ${dates[dates.length - 1] || '(なし)'} (設定済み ${dates.length}/${rows.length}件)`);
  console.log(`tour_name あり: ${withTourName}/${rows.length}`);
  console.log(`agent_name あり: ${withAgent}/${rows.length}`);
  console.log(`country あり: ${withCountry}/${rows.length}`);
  console.log(`statusの内訳: ${JSON.stringify(byStatus)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.yes && !SERVICE_KEY) {
    console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。--yes での本番実行にはservice_roleキーが必須です。');
    process.exit(1);
    return; // process.exitがモックされるテスト環境でも以降の処理へ進まないようにする
  }

  for (const p of [args.candidates, args.verify, args.reconcile]) {
    if (!fs.existsSync(path.resolve(p))) {
      console.error(`入力ファイルが見つかりません: ${path.resolve(p)}`);
      process.exit(1);
      return;
    }
  }

  const candidateRows = parseCsv(fs.readFileSync(path.resolve(args.candidates), 'utf8'))
    .filter((r) => r.length >= 2 && r[0] !== 'ref_no');
  const verifyRows = parseCsv(fs.readFileSync(path.resolve(args.verify), 'utf8'))
    .filter((r) => r.length >= 3 && r[0] !== 'ref_no');
  const verifyByRefNo = new Map(verifyRows.map((r) => [r[0], r[2]]));
  const reconcileRecords = JSON.parse(fs.readFileSync(path.resolve(args.reconcile), 'utf8'));
  const reconcileById = new Map(reconcileRecords.map((r) => [r.id, r]));

  const trueNewRefNos = [];
  const skippedNotTrueNew = [];
  for (const [refNo] of candidateRows.map((r) => [r[0]])) {
    const status = verifyByRefNo.get(refNo);
    if (status === 'true_new') trueNewRefNos.push(refNo);
    else skippedNotTrueNew.push({ refNo, status: status || '(verify結果に無し)' });
  }

  if (skippedNotTrueNew.length) {
    console.log(`⚠ verify結果でtrue_new以外・未検証のため対象から除外: ${skippedNotTrueNew.length}件`);
    skippedNotTrueNew.forEach((s) => console.log(`  ${s.refNo}: ${s.status}`));
  }

  // 要確認リスト(scripts/data/needs_manual_review.csv、既定)に載っているref_noは、
  // 実データ目視確認で問題が見つかった等の理由で人間が明示的に除外を決めたものなので、
  // 存在すれば自動的に対象から除く(ファイルが無ければ除外なしで続行)。
  const reviewPath = path.resolve(args.review);
  let trueNewAfterReview = trueNewRefNos;
  if (fs.existsSync(reviewPath)) {
    const reviewRows = parseCsv(fs.readFileSync(reviewPath, 'utf8')).filter((r) => r.length >= 2 && r[0] !== 'ref_no');
    const reviewMap = new Map(reviewRows.map((r) => [r[0], r[1]]));
    const excludedForReview = trueNewRefNos.filter((refNo) => reviewMap.has(refNo));
    if (excludedForReview.length) {
      console.log(`⚠ 要確認リスト(${reviewPath})により対象から除外: ${excludedForReview.length}件`);
      excludedForReview.forEach((refNo) => console.log(`  ${refNo}: ${reviewMap.get(refNo)}`));
    }
    trueNewAfterReview = trueNewRefNos.filter((refNo) => !reviewMap.has(refNo));
  }

  console.log(`INSERT対象候補: ${trueNewAfterReview.length}件`);

  if (!trueNewAfterReview.length) {
    console.log('対象がありません。終了します。');
    return;
  }

  const rows = trueNewAfterReview.map((refNo) => {
    const record = reconcileById.get(refNo);
    if (!record) throw new Error(`reconcile.jsonにref_no=${refNo}のレコードが見つかりません`);
    return buildInsertRow(refNo, record);
  });

  if (!args.yes) {
    console.log('\n=== dry-run(書き込みは一切行っていません) ===');
    const sampleIdx = pickSampleIndices(rows.length);
    sampleIdx.forEach((i, k) => {
      const label = i < 5 ? '先頭' : i >= rows.length - 5 ? '末尾' : 'ランダム';
      printRowSummary(`${label}サンプル`, rows[i]);
    });
    printSummary(rows);
    console.log('\n本番へ書き込むには --yes を付けて再実行してください(実行前に対話確認があります)。');
    return;
  }

  // ── --yes: 本番実行 ──────────────────────────────────────────────
  console.log('\n重複チェック中(読み取りのみ)...');
  const existing = await sbFindExistingRefNos(trueNewAfterReview, SERVICE_KEY);
  if (existing.length) {
    console.error(`\n!!!!! 中断: ${existing.length}件のref_noが既に本番bookingsに存在します(verify_new_candidates.jsの結果と矛盾) !!!!!`);
    existing.forEach((e) => console.error(`  既存: ref_no=${e.ref_no} id=${e.id}`));
    console.error('INSERT対象を見直してください。書き込みは一切行っていません。');
    process.exit(1);
    return;
  }
  console.log('重複なし。続行します。');

  printSummary(rows);

  const finalAns = await ask(`\n上記${rows.length}件を本番bookingsへ実際にINSERTします。よろしいですか? (y と入力): `);
  if (finalAns.trim().toLowerCase() !== 'y') {
    console.log('中止しました。書き込みは行っていません。');
    return;
  }

  // ── バックアップをINSERT実行前に必ず保存する ──────────────────────
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const backupDir = path.resolve('scripts/data');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `access_new_bookings_backup_${timestamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows, null, 2), 'utf8');
  const reread = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!Array.isArray(reread) || reread.length !== rows.length) {
    console.error(`バックアップの書き込み確認に失敗しました(${backupPath})。書き込みを中止します。`);
    process.exit(1);
    return;
  }
  console.log(`バックアップを保存しました: ${backupPath}`);

  // ── 1件ずつINSERT。失敗したら即座に停止する ──────────────────────
  const inserted = []; // {ref_no, id}
  let failedRefNo = null;
  let failedError = null;

  for (const row of rows) {
    try {
      const result = await sbInsertOne(row);
      inserted.push({ ref_no: row.ref_no, id: result.id });
    } catch (e) {
      failedRefNo = row.ref_no;
      failedError = e;
      break;
    }
  }

  console.log('\n=== 実行結果 ===');
  console.log(`処理対象件数: ${rows.length}`);
  console.log(`成功件数: ${inserted.length}`);
  console.log(`失敗件数: ${failedRefNo ? 1 : 0}`);
  if (failedRefNo) {
    console.log(`ref_no=${failedRefNo} で失敗したため処理を停止しました: ${failedError.message}`);
    console.log(`成功した${inserted.length}件を取り消す場合は、以下のidを削除してください:`);
    inserted.forEach((r) => console.log(`  ref_no=${r.ref_no} id=${r.id}`));
    console.log(`バックアップファイル: ${backupPath}`);
    return;
  }
  console.log('全件成功しました。');
  console.log(`バックアップファイル: ${backupPath}`);

  // ── 自己検証: 実際にSupabaseから再取得して反映を確認する ──────────────
  console.log('\n=== 反映結果の自己検証(再取得) ===');
  const insertedRefNos = inserted.map((r) => r.ref_no);
  const CHUNK = 80;
  let verifiedCount = 0;
  const mismatches = [];
  for (let i = 0; i < insertedRefNos.length; i += CHUNK) {
    const chunk = insertedRefNos.slice(i, i + CHUNK);
    const list = chunk.map((r) => encodeURIComponent(r)).join(',');
    const rowsBack = await sbGet(`bookings?select=id,ref_no&ref_no=in.(${list})`, SERVICE_KEY);
    const foundRefNos = new Set(rowsBack.map((r) => r.ref_no));
    chunk.forEach((refNo) => {
      if (foundRefNos.has(refNo)) verifiedCount++;
      else mismatches.push(refNo);
    });
  }
  console.log(`再取得で確認できた件数: ${verifiedCount}/${insertedRefNos.length}`);
  if (mismatches.length) {
    console.log(`!!!!! 警告: 以下のref_noは再取得で見つかりませんでした: ${mismatches.join(', ')} !!!!!`);
  } else {
    console.log('全件、実際にbookingsへ反映されていることを確認しました。');
  }
}

main().catch((e) => {
  console.error('エラー:', e);
  process.exit(1);
});
