// クレジットカード明細OCRの日付組み立てロジック(ccAssembleTransactionDate)を単体テストする。
// index.html内から該当関数のソースをそのまま抜き出してevalし(コピペではなく実際に動いている
// コードをテスト対象にするため)、AIの読み取り結果を模したモック入力を与えて検証する。
//
// 背景: 従来はAIが和暦→西暦の変換(+2018)まで一括で行い、YYYY-MM-DD形式の"date"を直接
// 返していたが、和暦の年数を月と取り違える等の誤読が繰り返し報告された。AIの役割を
// 「era_type/era_year_raw/month/day/date_confidenceをそのまま報告する」ことだけに縮小し、
// 西暦への変換算術はコード側(ccAssembleTransactionDate)で機械的に行う設計に変更した。
// このテストは、AIの読み取り部分をモック(固定入力)にした上で、コード側の変換ロジックのみを
// 検証する。
//
// 検証観点:
// 1) 令和表記(「令和8年2月19日」等)が正しくYYYY-MM-DDに変換されること
// 2) 「8 6 12」のような3数字表記(和暦年8・月6・日12)が正しく2026-06-12になること(年と月の
//    取り違えが起きないこと)
// 3) 西暦表記(4桁・2桁)が従来通り正しく組み立てられること(回帰がないこと)
// 4) era_type='unknown'の場合、needs_review=trueになること
// 5) date_confidence='low'の場合、era_type/month/dayが揃っていてもneeds_review=trueになること
// 6) date_confidence='high'かつ通常ケースでは、needs_reviewが不要に立たないこと(過剰検知防止)
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

const src = extractFn('ccAssembleTransactionDate');
const fn = new Function(`${src}\nreturn ccAssembleTransactionDate;`);
const ccAssembleTransactionDate = fn();

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('OK  ', name); }
  else { fail++; console.log('FAIL', name, 'actual=', JSON.stringify(actual), 'expected=', JSON.stringify(expected)); }
}

// ── 1) 令和表記の変換(基本) ──
check(
  '令和8年2月19日 → 2026-02-19(年月日の取り違えなし)',
  ccAssembleTransactionDate({ era_type: 'reiwa', era_year_raw: 8, month: 2, day: 19, date_confidence: 'high', needs_review: false }),
  { date: '2026-02-19', needs_review: false }
);

// ── 2) 「8 6 12」形式(和暦年8・月6・日12) ──
check(
  '「8 6 12」(era_year_raw=8,month=6,day=12) → 2026-06-12',
  ccAssembleTransactionDate({ era_type: 'reiwa', era_year_raw: 8, month: 6, day: 12, date_confidence: 'high', needs_review: false }),
  { date: '2026-06-12', needs_review: false }
);

// 令和元年(1年)の境界値
check(
  '令和1年1月1日 → 2019-01-01',
  ccAssembleTransactionDate({ era_type: 'reiwa', era_year_raw: 1, month: 1, day: 1, date_confidence: 'high', needs_review: false }),
  { date: '2019-01-01', needs_review: false }
);

// ── 3) 西暦表記(回帰確認) ──
check(
  '西暦4桁(2026年5月20日) → 2026-05-20',
  ccAssembleTransactionDate({ era_type: 'western', era_year_raw: 2026, month: 5, day: 20, date_confidence: 'high', needs_review: false }),
  { date: '2026-05-20', needs_review: false }
);
check(
  '西暦2桁("26"年5月20日) → 2026-05-20',
  ccAssembleTransactionDate({ era_type: 'western', era_year_raw: 26, month: 5, day: 20, date_confidence: 'high', needs_review: false }),
  { date: '2026-05-20', needs_review: false }
);

// ── 4) era_type='unknown' → needs_review ──
check(
  'era_type=unknown → needs_review=true・date=null',
  ccAssembleTransactionDate({ era_type: 'unknown', era_year_raw: null, month: null, day: null, date_confidence: 'low', needs_review: true }),
  { date: null, needs_review: true }
);

// ── 5) date_confidence='low' → era_type等が揃っていてもneeds_review ──
check(
  'era_type/month/dayが揃っていてもdate_confidence=low → needs_review=true',
  ccAssembleTransactionDate({ era_type: 'reiwa', era_year_raw: 8, month: 3, day: 2, date_confidence: 'low', needs_review: false }),
  { date: null, needs_review: true }
);
check(
  '西暦でもdate_confidence=low → needs_review=true(和暦・西暦どちらも同様に扱う)',
  ccAssembleTransactionDate({ era_type: 'western', era_year_raw: 2026, month: 5, day: 20, date_confidence: 'low', needs_review: false }),
  { date: null, needs_review: true }
);

// ── 6) 通常ケース(date_confidence=high・era_type明確)では過剰検知しない ──
check(
  '通常ケース(high・reiwa) → needs_reviewは立たない',
  ccAssembleTransactionDate({ era_type: 'reiwa', era_year_raw: 7, month: 12, day: 31, date_confidence: 'high', needs_review: false }),
  { date: '2025-12-31', needs_review: false }
);
check(
  '通常ケース(high・western) → needs_reviewは立たない',
  ccAssembleTransactionDate({ era_type: 'western', era_year_raw: 2026, month: 1, day: 1, date_confidence: 'high', needs_review: false }),
  { date: '2026-01-01', needs_review: false }
);

// ── 追加の異常系(退行防止) ──
check(
  'AI自身がneeds_review=trueを申告した場合は尊重する',
  ccAssembleTransactionDate({ era_type: 'reiwa', era_year_raw: 8, month: 6, day: 12, date_confidence: 'high', needs_review: true }),
  { date: null, needs_review: true }
);
check(
  '月が範囲外(13)なら組み立てず要確認',
  ccAssembleTransactionDate({ era_type: 'western', era_year_raw: 2026, month: 13, day: 1, date_confidence: 'high', needs_review: false }),
  { date: null, needs_review: true }
);
check(
  'era_year_rawがnullなら要確認',
  ccAssembleTransactionDate({ era_type: 'reiwa', era_year_raw: null, month: 6, day: 12, date_confidence: 'high', needs_review: false }),
  { date: null, needs_review: true }
);
check(
  '入力自体がnullでも例外を投げず要確認を返す',
  ccAssembleTransactionDate(null),
  { date: null, needs_review: true }
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
