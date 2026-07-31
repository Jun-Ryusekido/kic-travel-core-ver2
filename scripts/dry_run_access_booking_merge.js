// KIC_INBOUND(旧Accessシステム)の予約台帳データ統合(ドライラン)。
//
// このスクリプトはSupabaseへの書き込みを一切行わない(読み取りのみ)。UPDATE/INSERT/DELETEに
// 相当するAPI呼び出しはコード中に一切存在しない。sbGet はGETリクエストのみを発行する。
//
// 入力: scripts/data/access_booking_reconcile.json
//   [{ id, status: 'both'|'new_only'|'old_only', A: {...}, B: {...}, diffs: [...] }, ...]
//   id は Accessの予約台帳ID = bookings.ref_no と対応する(実データ#1153で確認済み)。
//   A = 2025/02/20版スナップショット、B = 2026/07/17版スナップショット。
//
// 統合ルール(反映対象列のみ): 現在値(bookings) → Aの値と違えば上書き → その結果に対して
//   Bの値と違えば上書き(最終値)。AB両方で現在と違う場合はBが勝つ。
//
// 判定: 各レコードについて bookings を ref_no(= id) で実際に検索する。
//   - 見つかった場合: 反映対象列だけを比較し、現在値と最終値が異なる列を「変更あり」として記録する。
//   - 見つからない場合: 実際の照合結果に基づき「新規追加候補」として別リストに計上する
//     (JSON側のstatus値がどうであれ、本番に存在しない場合は必ずこちらに入る。用語としては
//     status='new_only'が主にこれに該当する想定だが、判定は実際のDB照合結果を優先する)。
//
// 出力: scripts/data/access_booking_merge_dryrun_changes.csv (変更が発生するレコードの列単位の一覧)
//       scripts/data/access_booking_merge_dryrun_new_candidates.csv (新規追加候補の一覧)
//
// 実行方法: node scripts/dry_run_access_booking_merge.js
//   任意で --input <path> で入力JSONのパスを変更、--outdir <dir> で出力先ディレクトリを変更できる。
//
// !!! ACCESS側のJSONキー名(ACCESS_FIELD_MAP参照)は、実際のaccess_booking_reconcile.jsonの
// !!! 中身を確認して、必要に応じて修正すること。ここに書かれているキー名(担当者/出発日等)は
// !!! 会話でのやり取りに基づく暫定値であり、実データでの検証が済んでいない。
//
// このファイルの計算ロジック(ACCESS_FIELD_MAP/computeFinalValue/findChangedRecords等)は
// scripts/apply_access_booking_merge.js からrequire()して再利用する。ドライランと実書き込みで
// 判定ロジックが食い違う(ドライランでは変更なしと出たのに実際は書き込まれる、等)事故を防ぐため、
// ロジックの複製は行わない。

const fs = require('fs');
const path = require('path');

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

// bookings列名 → Access側(A/Bオブジェクト)のキー名。実データ確認後に要修正。
const ACCESS_FIELD_MAP = {
  staff_in_charge: '担当者',
  in_date: '出発日',
  out_date: '帰国予定日',
  pax_adult: 'ADT',
  pax_child: 'CHD',
  pax_infant: 'INF',
  agent_name: '会社名',
  tour_name: '行程',
  country: '国名',
  booking_type: '種別',
};
// statusのみ特殊変換(手配完了="済"の場合のみ"Closed"とみなす。それ以外は反映対象外=undefined)。
const STATUS_ACCESS_KEY = '手配完了';
function mapAccessStatus(rawValue) {
  return rawValue === '済' ? 'Closed' : undefined;
}

const REFLECT_COLUMNS = [...Object.keys(ACCESS_FIELD_MAP), 'status'];

function parseArgs(argv, defaults) {
  const args = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') args.input = argv[++i];
    if (argv[i] === '--outdir') args.outdir = argv[++i];
  }
  return args;
}

async function sbGet(pathAndQuery, sbUrl, sbKey) {
  const r = await fetch(`${sbUrl}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
  });
  if (!r.ok) throw new Error(`Supabase GET ${pathAndQuery}: ${r.status} ${await r.text()}`);
  return r.json();
}

// null/undefined/空文字/前後空白の違いを吸収して比較する。数値は文字列化してから比較する。
function normVal(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// 1レコード分について、col(bookings列名)ごとに「現在値→最終値」の変更を計算する。
// A/Bの値がその列で反映対象外(undefined)の場合はスキップする(=DBの値を一切変えない)。
function computeFinalValue(col, current, record) {
  let value = current;
  for (const snapshot of ['A', 'B']) {
    const snap = record[snapshot];
    if (!snap) continue;
    let snapValue;
    if (col === 'status') {
      snapValue = mapAccessStatus(snap[STATUS_ACCESS_KEY]);
    } else {
      const key = ACCESS_FIELD_MAP[col];
      snapValue = snap ? snap[key] : undefined;
    }
    if (snapValue === undefined) continue; // この列についてAccess側に反映すべき値が無い
    if (normVal(snapValue) !== normVal(value)) {
      value = snapValue;
    }
  }
  return value;
}

// records(JSON全体)を実際のbookingsに照合し、レコードごとの変更内容を計算する共通ロジック。
// 戻り値: { changed: [{ refNo, bookingId, changes: [{column, before, after}] }], newCandidates: [{refNo, status}] }
async function findChangedRecords(records, { sbUrl = SB_URL, sbKey = SB_KEY } = {}) {
  const changed = [];
  const newCandidates = [];

  for (const record of records) {
    const refNo = record.id;
    if (!refNo) continue;

    const found = await sbGet(
      `bookings?select=id,ref_no,${REFLECT_COLUMNS.join(',')}&ref_no=eq.${encodeURIComponent(refNo)}`,
      sbUrl,
      sbKey
    );
    if (!found || !found.length) {
      newCandidates.push({ refNo, status: record.status });
      continue;
    }
    const booking = found[0];

    const changes = [];
    for (const col of REFLECT_COLUMNS) {
      const current = booking[col];
      const final = computeFinalValue(col, current, record);
      if (normVal(final) !== normVal(current)) {
        changes.push({ column: col, before: current, after: final });
      }
    }
    if (changes.length) {
      changed.push({ refNo, bookingId: booking.id, changes });
    }
  }

  return { changed, newCandidates };
}

function toCsvRow(fields) {
  return fields
    .map((f) => {
      const s = f === null || f === undefined ? '' : String(f);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    input: 'scripts/data/access_booking_reconcile.json',
    outdir: 'scripts/data',
  });
  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`入力JSONが見つかりません: ${inputPath}`);
    console.error('scripts/data/access_booking_reconcile.json を配置してから再実行してください。');
    process.exit(1);
  }
  const records = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  console.log(`入力レコード数: ${records.length}`);

  const { changed, newCandidates } = await findChangedRecords(records);

  const outDir = path.resolve(args.outdir);
  fs.mkdirSync(outDir, { recursive: true });

  const changedRows = [];
  changed.forEach((r) => {
    r.changes.forEach((c) => changedRows.push({ ref_no: r.refNo, column: c.column, before: c.before, after: c.after }));
  });

  const changesPath = path.join(outDir, 'access_booking_merge_dryrun_changes.csv');
  const changesCsv = ['ref_no,column,before,after']
    .concat(changedRows.map((r) => toCsvRow([r.ref_no, r.column, r.before, r.after])))
    .join('\n');
  fs.writeFileSync(changesPath, changesCsv, 'utf8');

  const newCandidatesPath = path.join(outDir, 'access_booking_merge_dryrun_new_candidates.csv');
  const newCsv = ['ref_no,json_status']
    .concat(newCandidates.map((r) => toCsvRow([r.refNo, r.status])))
    .join('\n');
  fs.writeFileSync(newCandidatesPath, newCsv, 'utf8');

  // 列ごとの変更件数内訳
  const byColumn = {};
  changedRows.forEach((r) => {
    byColumn[r.column] = (byColumn[r.column] || 0) + 1;
  });

  console.log('=== ドライラン結果(DBへの書き込みは一切行っていません) ===');
  console.log(`変更が発生するレコード数: ${changed.length} / ${records.length}`);
  console.log(`変更セル数(列単位)の合計: ${changedRows.length}`);
  console.log('列ごとの変更件数内訳:');
  Object.entries(byColumn)
    .sort((a, b) => b[1] - a[1])
    .forEach(([col, n]) => console.log(`  ${col}: ${n}`));
  console.log(`新規追加候補(本番に存在しないref_no)件数: ${newCandidates.length}`);
  console.log(`出力: ${changesPath}`);
  console.log(`出力: ${newCandidatesPath}`);
}

module.exports = {
  ACCESS_FIELD_MAP,
  STATUS_ACCESS_KEY,
  mapAccessStatus,
  REFLECT_COLUMNS,
  normVal,
  computeFinalValue,
  findChangedRecords,
  toCsvRow,
  SB_URL,
  SB_KEY,
};

if (require.main === module) {
  main().catch((e) => {
    console.error('エラー:', e);
    process.exit(1);
  });
}
