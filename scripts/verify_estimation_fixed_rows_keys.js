// 見積もり保存時の estimation_fixed_rows 一括insertペイロードのキー構成を検証する。
// PostgRESTの一括insertは配列内の全オブジェクトが同一キー集合であることを要求し、
// 不一致だと「All object keys must match」で失敗する(index.html の allFrRows 組み立て箇所、
// api/table-crud.js の doReplaceByKey → 単一POST)。
//
// このスクリプトは index.html のオブジェクト生成ロジックをそのまま写し、
//   1) 固定費行のみ
//   2) 入場料行のみ
//   3) 両方
// の3パターンで、配列内の全オブジェクトのキー集合が一致することを検証する。
// 参考として、修正前(入場料行に section 無し)だと(3)が失敗することも示す。
// 実行: node scripts/verify_estimation_fixed_rows_keys.js

const estId = 'test-estimation-id';

// index.html:10207-10211(固定費行。変更なし)
function buildFixedRow(r, k) {
  return {
    estimation_id: estId, label: r.label || '',
    amounts: (r.amounts || []).map(a => Number(a) || 0),
    sort_order: k, section: r.section || 'hotel'
  };
}

// index.html:10212-10216(入場料行。★修正後: section:'' を追加)
function buildAdmissionRow(r, k) {
  const cts = r.contents || [];
  const label = '@admission:' + (r.remark || '') + (cts.some(c => c) ? '@@' + JSON.stringify(cts) : '');
  return { estimation_id: estId, label, amounts: (r.amounts || []).map(a => Number(a) || 0), sort_order: 1000 + k, section: '' };
}

// 修正前の入場料行(section 無し)。回帰検知用の再現。
function buildAdmissionRowOLD(r, k) {
  const cts = r.contents || [];
  const label = '@admission:' + (r.remark || '') + (cts.some(c => c) ? '@@' + JSON.stringify(cts) : '');
  return { estimation_id: estId, label, amounts: (r.amounts || []).map(a => Number(a) || 0), sort_order: 1000 + k };
}

function keySig(obj) { return Object.keys(obj).sort().join(','); }

// 全オブジェクトのキー集合が一致するか(PostgRESTの制約を模擬)
function keysAllMatch(rows) {
  if (!rows.length) return { ok: true, sig: '(空配列)' };
  const first = keySig(rows[0]);
  const bad = rows.find(r => keySig(r) !== first);
  return { ok: !bad, sig: first, mismatchSig: bad ? keySig(bad) : null };
}

// テストデータ(固定費2行・入場料2行)
const estFixedRows = [
  { label: 'ホテル代', amounts: [1000, 2000], section: 'hotel' },
  { label: 'バス代', amounts: [3000], section: 'transport' },
];
const estAdmissionRows = [
  { remark: '入場料A', contents: ['大人', '子供'], amounts: [500, 300] },
  { remark: '入場料B', contents: [], amounts: [800] },
];

const patterns = {
  '(1) 固定費行のみ': [...estFixedRows.map(buildFixedRow)],
  '(2) 入場料行のみ': [...estAdmissionRows.map(buildAdmissionRow)],
  '(3) 両方': [...estFixedRows.map(buildFixedRow), ...estAdmissionRows.map(buildAdmissionRow)],
};

let allPass = true;
console.log('=== 修正後: キー集合の一致検証 ===');
for (const [name, rows] of Object.entries(patterns)) {
  const res = keysAllMatch(rows);
  const status = res.ok ? 'OK' : 'NG';
  if (!res.ok) allPass = false;
  console.log(`  ${status}  ${name}  (${rows.length}件)  keys=[${res.sig}]${res.ok ? '' : `  ← 不一致 [${res.mismatchSig}]`}`);
}

// 回帰検知の妥当性: 修正前ロジックだと(3)が必ずNGになることを確認
console.log('\n=== 参考: 修正前(入場料行に section 無し)の再現 ===');
const oldBoth = [...estFixedRows.map(buildFixedRow), ...estAdmissionRows.map(buildAdmissionRowOLD)];
const oldRes = keysAllMatch(oldBoth);
console.log(`  ${oldRes.ok ? 'OK' : 'NG(=当時のエラー再現)'}  (3) 両方  keys=[${oldRes.sig}]${oldRes.ok ? '' : `  vs [${oldRes.mismatchSig}]`}`);
const harnessValid = !oldRes.ok; // 修正前はNGでなければ、この検証自体が無意味

console.log('\n=== 参考: 修正後(3)の実ペイロード ===');
console.log(JSON.stringify(patterns['(3) 両方'], null, 2));

if (allPass && harnessValid) {
  console.log('\n結果: PASS(全3パターンでキー集合が一致。修正前は(3)が不一致=当時のエラーを再現できることも確認)');
  process.exit(0);
} else {
  console.log('\n結果: FAIL');
  process.exit(1);
}
