// 請求書OCR(仕入明細)の消費税取り込みロジック(applyInvoiceTaxLines)を単体テストする。
// index.html内から該当関数のソースをそのまま抜き出してevalし(コピペではなく実際に動いている
// コードをテスト対象にするため)、AIの読み取り結果を模したモック入力を与えて検証する。
//
// 背景: 税抜表記の明細のみ抽出され、請求書記載の合計(税込)との間に消費税分の差額が生じても
// 消費税行が追加されない不具合(REF#876等)への対応。AIは明細(items)・税率別消費税額
// (tax_breakdown)・請求書合計(invoice_total_amount)を"転記"するだけで、税込⇔税抜の換算や
// 消費税額の算出は一切行わない。税抜/税込の判定と消費税行の追加はapplyInvoiceTaxLinesが
// コード側で機械的に行う。
//
// 検証観点:
// a) 明細合計＝請求書合計(税込表記)の場合、消費税行を追加しない(回帰確認)
// b) tax_breakdownが明記されている場合、その通りに消費税行を追加する(8%単独・8%+10%混在)
// c) tax_breakdownが無い場合、8%/10%の税込換算で一致すれば消費税額を算出して追加する
// d) いずれにも一致しない場合、消費税行を追加しない(従来通りの不一致警告に委ねる)
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  let startIdx = html.indexOf(`async function ${name}(`);
  if (startIdx === -1) startIdx = html.indexOf(`function ${name}(`);
  if (startIdx === -1) throw new Error('not found: ' + name);
  let depth = 0, i = html.indexOf('{', startIdx), started = false;
  for (; i < html.length; i++) {
    if (html[i] === '{') { depth++; started = true; }
    else if (html[i] === '}') { depth--; if (started && depth === 0) { i++; break; } }
  }
  return html.slice(startIdx, i);
}

const src = extractFn('applyInvoiceTaxLines');
const fn = new Function(`${src}\nreturn applyInvoiceTaxLines;`);
const applyInvoiceTaxLines = fn();

let pass = 0, fail = 0;
function check(name, actual, expectedFn) {
  const result = expectedFn(actual);
  if (result === true) { pass++; console.log('OK  ', name); }
  else { fail++; console.log('FAIL', name, 'actual=', JSON.stringify(actual), 'reason=', result); }
}

// ── a) 明細合計＝請求書合計(税込表記) → 消費税行を追加しない(回帰) ──
{
  const expenses = [
    { supplier_name: '割烹たなか', amount: 8000, expense_date: '2026-08-20', content: '食事代' },
  ];
  const parsed = { invoice_total_amount: 8000, tax_breakdown: [] };
  const r = applyInvoiceTaxLines(expenses, parsed);
  check('a) 明細合計=請求書合計(税込) → 消費税行なし', r, (r) =>
    r.expenses.length === 1 && r.taxAppliedNote === '' ? true : '消費税行が追加された、または注記が出た');
}

// ── b) REF#876相当: tax_breakdownが明記されている(8%単独) ──
{
  const expenses = [
    { supplier_name: '株式会社アッキーインターナショナル', amount: 1250, expense_date: '2026-08-06', content: '品目A', invoice_no: 'INV-876' },
    { supplier_name: '株式会社アッキーインターナショナル', amount: 2160, expense_date: '2026-08-06', content: '品目B', invoice_no: 'INV-876' },
    { supplier_name: '株式会社アッキーインターナショナル', amount: 9840, expense_date: '2026-08-06', content: '品目C', invoice_no: 'INV-876' },
  ];
  const parsed = { invoice_total_amount: 14310, tax_breakdown: [{ rate: 8, tax_amount: 1060 }] };
  const r = applyInvoiceTaxLines(expenses, parsed);
  const taxLine = r.expenses[3];
  check('b) REF#876(tax_breakdown明記・8%) → 消費税行1件追加・合計一致', r, (r) => {
    if (r.expenses.length !== 4) return `明細件数が4件でない(${r.expenses.length}件)`;
    if (!taxLine || taxLine.amount !== 1060) return '消費税行の金額が1060円でない';
    if (taxLine.content !== '消費税(8%)') return 'content表記が不正: ' + taxLine.content;
    if (taxLine.supplier_name !== '株式会社アッキーインターナショナル') return '仕入先名が明細と揃っていない';
    const sum = r.expenses.reduce((s, e) => s + e.amount, 0);
    if (sum !== 14310) return `合計が14310と一致しない(${sum})`;
    if (r.taxAppliedNote !== '') return '注記が出るべきでない(bはtax_breakdown由来のため)';
    return true;
  });
}

// ── b') 8%と10%が混在する請求書 → 消費税行が2行になる ──
{
  const expenses = [
    { supplier_name: '八百屋', amount: 1000, expense_date: '2026-08-10', content: '食品' },
    { supplier_name: '八百屋', amount: 2000, expense_date: '2026-08-10', content: '雑貨' },
  ];
  const parsed = { invoice_total_amount: 3280, tax_breakdown: [{ rate: 8, tax_amount: 80 }, { rate: 10, tax_amount: 200 }] }; // 1000+2000+80+200=3280
  const r = applyInvoiceTaxLines(expenses, parsed);
  check('b\') 8%+10%混在 → 消費税行2行、合計一致', r, (r) => {
    const taxLines = r.expenses.slice(2);
    if (taxLines.length !== 2) return `消費税行が2行でない(${taxLines.length}行)`;
    const rates = taxLines.map(t => t.content).sort().join(',');
    if (rates !== '消費税(10%),消費税(8%)') return 'レート表記が不正: ' + rates;
    const sum = r.expenses.reduce((s, e) => s + e.amount, 0);
    if (sum !== 3280) return `合計が3280と一致しない(${sum})`;
    return true;
  });
}

// ── c) tax_breakdownが空で、明細合計×1.08で請求書合計と一致する場合 ──
{
  const expenses = [
    { supplier_name: '仕入先C', amount: 5000, expense_date: '2026-08-15', content: '内容C' },
  ];
  const parsed = { invoice_total_amount: 5400, tax_breakdown: [] }; // 5000*1.08=5400
  const r = applyInvoiceTaxLines(expenses, parsed);
  check('c) tax_breakdownなし・×1.08で一致 → 消費税額を算出して追加・注記あり', r, (r) => {
    if (r.expenses.length !== 2) return `明細件数が2件でない(${r.expenses.length}件)`;
    const taxLine = r.expenses[1];
    if (taxLine.amount !== 400) return `消費税額が400円でない(${taxLine.amount})`;
    if (taxLine.content !== '消費税(8%)') return 'content表記が不正: ' + taxLine.content;
    if (!r.taxAppliedNote || !r.taxAppliedNote.includes('明細合計から算出')) return '注記が出ていない';
    return true;
  });
}

// ── c') ×1.10で一致する場合(10%) ──
{
  const expenses = [
    { supplier_name: '仕入先D', amount: 10000, expense_date: '2026-08-16', content: '内容D' },
  ];
  const parsed = { invoice_total_amount: 11000, tax_breakdown: [] }; // 10000*1.10=11000
  const r = applyInvoiceTaxLines(expenses, parsed);
  check('c\') tax_breakdownなし・×1.10で一致 → 10%として算出', r, (r) => {
    const taxLine = r.expenses[1];
    if (!taxLine || taxLine.amount !== 1000) return '消費税額が1000円でない';
    if (taxLine.content !== '消費税(10%)') return 'content表記が不正: ' + taxLine.content;
    return true;
  });
}

// ── d) いずれにも一致しない → 消費税行を追加しない(従来通りの不一致警告に委ねる) ──
{
  const expenses = [
    { supplier_name: '仕入先E', amount: 5000, expense_date: '2026-08-17', content: '内容E' },
  ];
  const parsed = { invoice_total_amount: 6000, tax_breakdown: [] }; // 5000*1.08=5400, *1.10=5500、どちらも6000と不一致
  const r = applyInvoiceTaxLines(expenses, parsed);
  check('d) いずれにも一致しない → 消費税行を追加しない', r, (r) =>
    r.expenses.length === 1 && r.taxAppliedNote === '' ? true : '消費税行が誤って追加された');
}

// ── d') tax_breakdownはあるが計算が合わない → フォールスルーしてdと同じ扱いになる ──
{
  const expenses = [
    { supplier_name: '仕入先F', amount: 5000, expense_date: '2026-08-18', content: '内容F' },
  ];
  const parsed = { invoice_total_amount: 5999, tax_breakdown: [{ rate: 8, tax_amount: 1 }] }; // 5000+1=5001≠5999、×1.08/1.10も不一致
  const r = applyInvoiceTaxLines(expenses, parsed);
  check('d\') tax_breakdownの計算が合わない → 消費税行を追加しない', r, (r) =>
    r.expenses.length === 1 && r.taxAppliedNote === '' ? true : '消費税行が誤って追加された');
}

// ── 追加の異常系(退行防止) ──
check('invoiceTotalが0/無し → 変更なし', applyInvoiceTaxLines([{ amount: 100 }], { invoice_total_amount: 0 }), (r) =>
  r.expenses.length === 1 && r.taxAppliedNote === '' ? true : '不正な変更');
check('expensesが空配列 → 変更なし・例外なし', applyInvoiceTaxLines([], { invoice_total_amount: 1000 }), (r) =>
  r.expenses.length === 0 ? true : '不正な変更');
check('parsedがnullでも例外を投げない', applyInvoiceTaxLines([{ amount: 100 }], null), (r) =>
  r.expenses.length === 1 ? true : '不正な変更');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
