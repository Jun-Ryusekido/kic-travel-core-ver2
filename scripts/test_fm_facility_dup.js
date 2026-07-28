// 観光地予約管理タブAI読み取り機能の重複チェックロジック(fmDup*/fmClassifyForDuplicates)を
// 単体テストする。index.html内から該当関数のソースをそのまま抜き出してevalし(コピペではなく
// 実際に動いているコードをテスト対象にするため)、モックのsb(supabaseクライアント)を注入して
// DBアクセスなしで0件/1件/複数件・完全一致/一部相違の各パターンを検証する。
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  let startIdx = html.indexOf(`async function ${name}(`);
  if (startIdx === -1) startIdx = html.indexOf(`function ${name}(`);
  if (startIdx === -1) throw new Error('not found: ' + name);
  // 対応する閉じ括弧までを簡易的に波括弧カウントで抜き出す
  let depth = 0, i = html.indexOf('{', startIdx), started = false;
  for (; i < html.length; i++) {
    if (html[i] === '{') { depth++; started = true; }
    else if (html[i] === '}') { depth--; if (started && depth === 0) { i++; break; } }
  }
  return html.slice(startIdx, i);
}

const src = [
  extractFn('fmDupNormStr'),
  extractFn('fmDupNormNum'),
  extractFn('fmDupMatchKeyEqual'),
  extractFn('fmDupContentEqual'),
  extractFn('fmFetchExistingForDupCheck'),
  extractFn('fmClassifyForDuplicates'),
].join('\n\n');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('OK  ', name); }
  else { fail++; console.log('FAIL', name, 'actual=', JSON.stringify(actual), 'expected=', JSON.stringify(expected)); }
}

async function run() {
  // sb.from('booking_facilities').select('*').in('booking_id', ids) をモックする
  let mockExisting = [];
  const sb = {
    from(table) {
      return {
        select() {
          return {
            in(col, ids) {
              return Promise.resolve({ data: mockExisting.filter(r => ids.includes(r.booking_id)), error: null });
            },
          };
        },
      };
    },
  };

  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new AsyncFunction('sb', `${src}\nreturn { fmClassifyForDuplicates, fmDupMatchKeyEqual, fmDupContentEqual };`)(sb);
  const resolvedFn = await fn;

  // 0件
  let res = await resolvedFn.fmClassifyForDuplicates([]);
  check('0件のとき toInsert/conflicts とも空', res, { toInsert: [], conflicts: [] });

  // 1件・既存なし → toInsertへ
  mockExisting = [];
  res = await resolvedFn.fmClassifyForDuplicates([{ booking_id: '1', facility_name: 'A園', date: '2026-08-01', status: '手配OK', pax: 2, amount: 1000, confirmation_no: 'C1', memo: '' }]);
  check('1件・既存なし→toInsert', res.toInsert.length === 1 && res.conflicts.length === 0, true);

  // 完全一致(重複)→ どちらにも入らず無視
  mockExisting = [{ id: 99, booking_id: '1', facility_name: 'A園', date: '2026-08-01', status: '手配OK', pax: 2, amount: 1000, confirmation_no: 'C1', memo: '' }];
  res = await resolvedFn.fmClassifyForDuplicates([{ booking_id: '1', facility_name: 'A園', date: '2026-08-01', status: '手配OK', pax: 2, amount: 1000, confirmation_no: 'C1', memo: '' }]);
  check('完全一致→toInsert/conflictsとも0件(無視)', res, { toInsert: [], conflicts: [] });

  // 一致キーは同じだが内容が異なる→conflictsへ
  mockExisting = [{ id: 99, booking_id: '1', facility_name: 'A園', date: '2026-08-01', status: '問い合わせ中', pax: 2, amount: 1000, confirmation_no: '', memo: '' }];
  const newRow = { booking_id: '1', facility_name: 'A園', date: '2026-08-01', status: '手配OK', pax: 2, amount: 1500, confirmation_no: 'C2', memo: '' };
  res = await resolvedFn.fmClassifyForDuplicates([newRow]);
  check('内容相違→conflictsへ1件', res.toInsert.length === 0 && res.conflicts.length === 1 && res.conflicts[0].existingRow.id === 99, true);

  // 複数件混在: 1件目は既存と完全一致(無視)、2件目は新規(toInsert)、3件目は内容相違(conflicts)
  mockExisting = [
    { id: 1, booking_id: '10', facility_name: 'X', date: '2026-01-01', status: '手配OK', pax: 1, amount: 500, confirmation_no: '', memo: '' },
    { id: 2, booking_id: '10', facility_name: 'Y', date: '2026-01-02', status: '問い合わせ中', pax: 1, amount: 800, confirmation_no: '', memo: '' },
  ];
  res = await resolvedFn.fmClassifyForDuplicates([
    { booking_id: '10', facility_name: 'X', date: '2026-01-01', status: '手配OK', pax: 1, amount: 500, confirmation_no: '', memo: '' }, // 完全一致→無視
    { booking_id: '10', facility_name: 'Z', date: '2026-01-03', status: '手配OK', pax: 3, amount: 900, confirmation_no: '', memo: '' }, // 新規→toInsert
    { booking_id: '10', facility_name: 'Y', date: '2026-01-02', status: '手配OK', pax: 1, amount: 999, confirmation_no: '', memo: '' }, // 内容相違→conflicts
  ]);
  check('複数件混在: toInsert1件・conflicts1件・無視1件', res.toInsert.length === 1 && res.conflicts.length === 1, true);
  check('複数件混在: toInsertはZ', res.toInsert[0].facility_name, 'Z');
  check('複数件混在: conflictsはY(既存id2)', res.conflicts[0].existingRow.id, 2);

  // booking_idが無い行のみ→ fmFetchExistingForDupCheckは呼ばれず空配列扱い→toInsertへ
  res = await resolvedFn.fmClassifyForDuplicates([{ booking_id: '', facility_name: 'no ref', date: '', status: '', pax: 0, amount: 0, confirmation_no: '', memo: '' }]);
  check('booking_id空でもtoInsertへ(REF#未選択行の除外はUI層の責務)', res.toInsert.length, 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
