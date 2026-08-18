// クレジットカード明細OCRのツアーコード照合ロジック(_ccParseTourCode/_ccTourCodeMatches/
// _ccHintMatchesTourName/findCcMatchCandidates)を単体テストする。index.html内から該当関数の
// ソースをそのまま抜き出してevalし(コピペではなく実際に動いているコードをテスト対象にするため)、
// モックのsb(supabaseクライアント)を注入してDBアクセスなしで検証する。
//
// 検証観点:
// 1) O/0混同(手書き・OCRで数字の「0」とアルファベットの「O」を混同したケース)を吸収できること
// 2) hint_tour_codeがref_no/tour_codeと一致しないがtour_nameに埋め込まれているケースを
//    フォールバックで拾えること(請求書読み取り機能側の同種フォールバックに合わせて追加)
// 3) 既存の正しく動いているケース(ref_no番号のみ一致・tour_codeのアルファベット一致等)が
//    退行していないこと
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

function extractConst(name) {
  const startIdx = html.indexOf(`const ${name}`);
  if (startIdx === -1) throw new Error('not found: ' + name);
  const eqIdx = html.indexOf('=', startIdx);
  let i = eqIdx + 1;
  while (/\s/.test(html[i])) i++;
  let depth = 0, started = false, end = i;
  for (; end < html.length; end++) {
    if (html[end] === '[') { depth++; started = true; }
    else if (html[end] === ']') { depth--; if (started && depth === 0) { end++; break; } }
  }
  return html.slice(startIdx, end) + ';';
}

const src = [
  extractFn('_ccNormTourCode'),
  extractFn('_ccParseTourCode'),
  extractFn('_ccTourCodeMatches'),
  extractFn('_ccHintMatchesTourName'),
  extractFn('normalizeCardHolderForMatch'),
  extractConst('CARD_HOLDER_ALIAS_GROUPS'),
  extractConst('CC_PAYMENT_METHODS'),
  extractFn('normalizeLearnKey'),
  extractFn('fetchLearnedMappings'),
  extractFn('findCcMatchCandidates'),
].join('\n\n');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('OK  ', name); }
  else { fail++; console.log('FAIL', name, 'actual=', JSON.stringify(actual), 'expected=', JSON.stringify(expected)); }
}

// 汎用モックsb: select/eq/in/ilike/or/limit/orderをチェーン可能にし、awaitすると{data,error}を返す。
function makeMockSb(tables) {
  return {
    from(table) {
      let rows = (tables[table] || []).slice();
      const builder = {
        select() { return builder; },
        eq(col, val) { rows = rows.filter(r => String(r[col]) === String(val)); return builder; },
        in(col, vals) { rows = rows.filter(r => vals.includes(r[col])); return builder; },
        ilike(col, pattern) {
          const needle = String(pattern).replace(/%/g, '').toLowerCase();
          rows = rows.filter(r => String(r[col] || '').toLowerCase().includes(needle));
          return builder;
        },
        or(expr) {
          const conds = expr.split(',').map(c => { const [col, op, val] = c.split('.'); return { col, op, val }; });
          rows = rows.filter(r => conds.some(c => {
            if (c.op !== 'ilike') return false;
            const needle = String(c.val).replace(/%/g, '').toLowerCase();
            return String(r[c.col] || '').toLowerCase().includes(needle);
          }));
          return builder;
        },
        limit(n) { rows = rows.slice(0, n); return builder; },
        order() { return builder; },
        maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
        then(resolve, reject) { Promise.resolve({ data: rows, error: null }).then(resolve, reject); },
      };
      return builder;
    },
  };
}

async function run() {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  // ── 1) _ccParseTourCode/_ccTourCodeMatches: DB不要の純粋関数テスト ──
  {
    const fn = new AsyncFunction(`${src}\nreturn { _ccParseTourCode, _ccTourCodeMatches, _ccHintMatchesTourName };`);
    const { _ccParseTourCode, _ccTourCodeMatches, _ccHintMatchesTourName } = await fn();

    // 既存の正しく動いているケース(退行防止)
    check('通常: KIC0851_AKBのnum/alpha', _ccParseTourCode('KIC0851_AKB'), { num: 851, alpha: 'AKB' });
    check('通常: #851(alphaなし)のnum/alpha', _ccParseTourCode('#851'), { num: 851, alpha: '' });
    check('通常: 851-KK と #851 は数字のみ一致', _ccTourCodeMatches('851-KK', '#851'), true);
    check('通常: 851-KK と KIC0851_KK は完全一致', _ccTourCodeMatches('851-KK', 'KIC0851_KK'), true);
    check('通常: 851-KK と KIC0851_AK はalpha不一致で不一致', _ccTourCodeMatches('851-KK', 'KIC0851_AK'), false);
    check('通常: 番号が違う場合は不一致', _ccTourCodeMatches('851-KK', 'KIC0852_KK'), false);

    // O/0混同(新規対応): 数字部分にOが混入
    check('O/0混同: 数字部分の85O1→8501として解釈', _ccParseTourCode('85O1-KK'), { num: 8501, alpha: 'KK' });
    check('O/0混同: 85O1-KK と KIC8501_KK は一致', _ccTourCodeMatches('85O1-KK', 'KIC8501_KK'), true);
    check('O/0混同: 先頭のOを先頭ゼロとして吸収(O851→851)', _ccParseTourCode('O851-KK'), { num: 851, alpha: 'KK' });
    check('O/0混同: O851-KK と #851 は一致', _ccTourCodeMatches('O851-KK', '#851'), true);

    // O/0混同(新規対応): アルファベット部分に0が混入
    check('O/0混同: アルファベット部分の851-K0→alpha=KOとして解釈', _ccParseTourCode('851-K0'), { num: 851, alpha: 'KO' });
    check('O/0混同: 851-K0 と KIC0851_KO は一致', _ccTourCodeMatches('851-K0', 'KIC0851_KO'), true);
    check('O/0混同: 851-K0 と KIC0851_KK(無関係な別alpha)は不一致', _ccTourCodeMatches('851-K0', 'KIC0851_KK'), false);

    // tour_name突合フォールバック(新規対応)
    check('tour_name突合: 852_KKがtour_nameに埋め込まれていれば一致', _ccHintMatchesTourName('852-KK', '8泊 Tokyo-Kobe 852_KK'), true);
    check('tour_name突合: 番号が違えば不一致', _ccHintMatchesTourName('852-KK', '8泊 Tokyo-Kobe 900_KK'), false);
    check('tour_name突合: hintにalphaが無い場合は誤爆防止のため不一致扱い', _ccHintMatchesTourName('852', '8泊 Tokyo-Kobe 852_KK'), false);
    check('tour_name突合: hint/tourNameが空なら不一致', _ccHintMatchesTourName('', '852_KK'), false);
    check('tour_name突合: O/0混同のhintでもtour_name埋め込みに一致', _ccHintMatchesTourName('852-K0', '8泊 Tokyo-Kobe 852_KO'), true);
  }

  // ── 2) findCcMatchCandidates: DBモックを使った結合テスト ──
  {
    const fn = new AsyncFunction('sb', `${src}\nreturn { findCcMatchCandidates };`);

    // 2a) 既存の正しく動いているケース(退行防止): 手書きコードがref_noの番号のみ一致
    {
      const sb = makeMockSb({
        booking_costs: [
          { id: 'c1', booking_id: 'b1', amount: 5000, payment_method: 'クレジットカード(法人)', payment_date: '2026-05-20', memo: '' },
        ],
        bookings: [
          { id: 'b1', ref_no: '#851', tour_name: '8泊 Tokyo-Kobe', tour_code: null },
        ],
        learned_mappings: [],
        credit_card_statements: [],
      });
      const { findCcMatchCandidates } = await fn(sb);
      const cands = await findCcMatchCandidates({ amount: 5000, hint_tour_code: '851-KK', merchant_name: '〇〇商事', transaction_date: '2026-05-21' });
      check('結合: ref_no番号一致で1件・hintMatch=true', cands.length === 1 && cands[0].hintMatch === true, true);
    }

    // 2b) O/0混同: 手書きコードの数字部分にOが混入していてもref_no一致で拾える
    {
      const sb = makeMockSb({
        booking_costs: [
          { id: 'c2', booking_id: 'b2', amount: 8400, payment_method: 'クレジットカード(法人)', payment_date: '2026-06-10', memo: '' },
        ],
        bookings: [
          { id: 'b2', ref_no: '#8501', tour_name: '5泊 Osaka', tour_code: null },
        ],
        learned_mappings: [],
        credit_card_statements: [],
      });
      const { findCcMatchCandidates } = await fn(sb);
      const cands = await findCcMatchCandidates({ amount: 8400, hint_tour_code: '85O1-KK', merchant_name: '△△商店', transaction_date: '2026-06-11' });
      check('結合: O/0混同の手書きコードでもhintMatch=true', cands.length === 1 && cands[0].hintMatch === true, true);
    }

    // 2c) tour_name突合フォールバック: ref_no/tour_codeでは一致しないがtour_nameに埋め込まれている
    {
      const sb = makeMockSb({
        booking_costs: [
          { id: 'c3', booking_id: 'b3', amount: 12000, payment_method: 'クレジットカード(法人)', payment_date: '2026-07-01', memo: '' },
        ],
        bookings: [
          { id: 'b3', ref_no: '#900', tour_name: '6泊 Kyoto 852_KK', tour_code: null },
        ],
        learned_mappings: [],
        credit_card_statements: [],
      });
      const { findCcMatchCandidates } = await fn(sb);
      const cands = await findCcMatchCandidates({ amount: 12000, hint_tour_code: '852-KK', merchant_name: '□□レストラン', transaction_date: '2026-07-02' });
      check('結合: tour_name突合フォールバックでhintMatch=true', cands.length === 1 && cands[0].hintMatch === true, true);
    }

    // 2d) 退行防止: 手書きコードが全く無関係な場合はhintMatch=falseのまま(金額一致のみ)
    {
      const sb = makeMockSb({
        booking_costs: [
          { id: 'c4', booking_id: 'b4', amount: 3000, payment_method: 'クレジットカード(法人)', payment_date: '2026-05-01', memo: '' },
        ],
        bookings: [
          { id: 'b4', ref_no: '#700', tour_name: '3泊 Nara', tour_code: null },
        ],
        learned_mappings: [],
        credit_card_statements: [],
      });
      const { findCcMatchCandidates } = await fn(sb);
      const cands = await findCcMatchCandidates({ amount: 3000, hint_tour_code: '999-ZZ', merchant_name: '××商店', transaction_date: '2026-05-02' });
      check('結合: 無関係な手書きコードはhintMatch=false(金額一致のみ残る)', cands.length === 1 && cands[0].hintMatch === false, true);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
