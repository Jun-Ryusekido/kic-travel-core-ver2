// クレジットカード明細OCRのツアーコード照合ロジック(_ccExtractDigitRuns/_ccHintDigitsMatch/
// _ccParseTourCode/_ccTourCodeMatches/_ccHintMatchesTourName/findCcMatchCandidates)を単体
// テストする。index.html内から該当関数のソースをそのまま抜き出してevalし(コピペではなく
// 実際に動いているコードをテスト対象にするため)、モックのsb(supabaseクライアント)を
// 注入してDBアクセスなしで検証する。
//
// 検証観点:
// 1) O/0混同(手書き・OCRで数字の「0」とアルファベットの「O」を混同したケース)を吸収できること
// 2) hint_tour_codeがref_no/tour_codeと一致しないがtour_nameに埋め込まれているケースを
//    フォールバックで拾えること(請求書読み取り機能側の同種フォールバックに合わせて追加)
// 3) 既存の正しく動いているケース(ref_no番号のみ一致・tour_codeのアルファベット一致等)が
//    退行していないこと
// 4) hint_tour_code側の照合を「数字＋区切り文字＋英字」の厳密パースから「含まれる数字を
//    抽出して比較する」緩い方式に変更したことで、「REF#967」「TC967」等の前置き文字列・
//    英字の位置によらず数字さえ一致すれば拾えるようになったこと(ref_no/tour_code直接比較)。
//    ※tour_name埋め込み検索(_ccHintMatchesTourName)はこの変更の対象外で、従来通り
//    「数字＋区切り文字＋英字」の構造まで要求する厳密な比較のまま(自由記述の中の無関係な
//    数字への誤爆を避けるため)
// 5) 全角入力(全角数字・全角記号)を半角に変換してから照合できること
// 6) 1桁のみの数字列は誤マッチ防止のため照合対象から除外されること(CC_HINT_MIN_DIGITS)
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
  if (html[i] === '[') {
    let depth = 0, started = false, end = i;
    for (; end < html.length; end++) {
      if (html[end] === '[') { depth++; started = true; }
      else if (html[end] === ']') { depth--; if (started && depth === 0) { end++; break; } }
    }
    return html.slice(startIdx, end) + ';';
  }
  // 配列以外(数値・文字列等)のスカラー定数は、行末のセミコロンまでをそのまま抜き出す。
  const semiIdx = html.indexOf(';', i);
  return html.slice(startIdx, semiIdx) + ';';
}

const src = [
  extractFn('toHalfWidth'),
  extractFn('_ccNormTourCode'),
  extractFn('normalizeHintTourCodeInput'),
  extractConst('CC_HINT_MIN_DIGITS'),
  extractFn('_ccExtractDigitRuns'),
  extractFn('_ccHintDigitsMatch'),
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

  // ── 1.5) _ccExtractDigitRuns/_ccHintDigitsMatch: 緩い数字抽出方式のDB不要な純粋関数テスト ──
  {
    const fn = new AsyncFunction(`${src}\nreturn { _ccExtractDigitRuns, _ccHintDigitsMatch };`);
    const { _ccExtractDigitRuns, _ccHintDigitsMatch } = await fn();

    // 前置き文字列(REF#・TC等)や区切り文字の位置によらず数字を抽出できること
    check('数字抽出: "REF#967"から967を抽出', _ccExtractDigitRuns('REF#967'), [967]);
    check('数字抽出: "TC967"(前置きが英字)から967を抽出', _ccExtractDigitRuns('TC967'), [967]);
    check('数字抽出: "967-TC"から967を抽出', _ccExtractDigitRuns('967-TC'), [967]);
    check('数字抽出: "967_TC"から967を抽出', _ccExtractDigitRuns('967_TC'), [967]);
    check('数字抽出: 複数の数字列("REF#967 TC1044")を両方抽出', _ccExtractDigitRuns('REF#967 TC1044'), [967, 1044]);

    // 1桁のみの数字列は誤マッチ防止のため除外(CC_HINT_MIN_DIGITS)されること
    check('数字抽出: 1桁のみ("5-TC")は除外される', _ccExtractDigitRuns('5-TC'), []);
    check('数字抽出: 2桁("80-TC")は除外されない', _ccExtractDigitRuns('80-TC'), [80]);

    // 全角入力(全角数字・全角記号・全角スペース)を半角に変換してから抽出できること
    check('数字抽出: 全角数字("９６７")から967を抽出', _ccExtractDigitRuns('９６７'), [967]);
    check('数字抽出: 全角記号込み("＃９６７")から967を抽出', _ccExtractDigitRuns('＃９６７'), [967]);
    check('数字抽出: 全角ハイフン("９６７－ＴＣ")から967を抽出', _ccExtractDigitRuns('９６７－ＴＣ'), [967]);

    // O/0混同(既存対応の維持確認)
    check('数字抽出: O/0混同("85O1-KK")から8501を抽出', _ccExtractDigitRuns('85O1-KK'), [8501]);
    check('数字抽出: 先頭O("O851-KK")から851を抽出', _ccExtractDigitRuns('O851-KK'), [851]);

    // _ccHintDigitsMatch: hintとtargetのいずれかの数字が1つでも一致すればtrue
    check('数字一致: "REF#967" vs "#967" は一致', _ccHintDigitsMatch('REF#967', '#967'), true);
    check('数字一致: "REF#967" vs "KIC0967_TC" は一致', _ccHintDigitsMatch('REF#967', 'KIC0967_TC'), true);
    check('数字一致: 全角"ＴＣ９６７" vs "#967" は一致', _ccHintDigitsMatch('ＴＣ９６７', '#967'), true);
    check('数字一致: 複数数字のうち一方が一致すれば一致("REF#967 TC1044" vs "#967")', _ccHintDigitsMatch('REF#967 TC1044', '#967'), true);
    check('数字一致: 番号が違えば不一致', _ccHintDigitsMatch('REF#967', '#968'), false);
    check('数字一致: 1桁のみは除外され不一致("5-TC" vs "#5")', _ccHintDigitsMatch('5-TC', '#5'), false);
    check('数字一致: 2桁は除外されず一致("80-TC" vs "#80")', _ccHintDigitsMatch('80-TC', '#80'), true);
    // 設計上の意図的な変更点: tour_codeのアルファベット略称の違いは、ref_no/tour_code直接
    // 比較(_ccHintDigitsMatch)ではもはや区別しない(数字さえ一致すればよいという設計のため)。
    // ※tour_name埋め込み検索(_ccHintMatchesTourName、上記1)は従来通りalpha一致まで要求する。
    check('数字一致(意図的な変更): "851-KK" vs "KIC0851_AK"(alpha違い)も数字のみで一致', _ccHintDigitsMatch('851-KK', 'KIC0851_AK'), true);
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

    // 2e) 新規対応: 「REF#967」のように前置き文字列＋#が付く形式でも、従来の厳密パース
    // (数字＋区切り文字＋英字)では拾えなかったが、数字抽出方式では拾えること
    {
      const sb = makeMockSb({
        booking_costs: [
          { id: 'c5', booking_id: 'b5', amount: 7000, payment_method: 'クレジットカード(法人)', payment_date: '2026-08-01', memo: '' },
        ],
        bookings: [
          { id: 'b5', ref_no: '#967', tour_name: '4泊 Fukuoka', tour_code: null },
        ],
        learned_mappings: [],
        credit_card_statements: [],
      });
      const { findCcMatchCandidates } = await fn(sb);
      const cands = await findCcMatchCandidates({ amount: 7000, hint_tour_code: 'REF#967', merchant_name: '◇◇物産', transaction_date: '2026-08-02' });
      check('結合: 「REF#967」形式でもhintMatch=true(新規対応)', cands.length === 1 && cands[0].hintMatch === true, true);
    }

    // 2f) 新規対応: 全角入力(全角数字・全角記号)の手書きコードでも半角に正規化して拾えること
    {
      const sb = makeMockSb({
        booking_costs: [
          { id: 'c6', booking_id: 'b6', amount: 9500, payment_method: 'クレジットカード(法人)', payment_date: '2026-08-05', memo: '' },
        ],
        bookings: [
          { id: 'b6', ref_no: '#967', tour_name: '2泊 Sapporo', tour_code: null },
        ],
        learned_mappings: [],
        credit_card_statements: [],
      });
      const { findCcMatchCandidates } = await fn(sb);
      const cands = await findCcMatchCandidates({ amount: 9500, hint_tour_code: 'ＴＣ９６７', merchant_name: '☆☆商会', transaction_date: '2026-08-06' });
      check('結合: 全角入力「ＴＣ９６７」でもhintMatch=true(新規対応)', cands.length === 1 && cands[0].hintMatch === true, true);
    }

    // 2g) 新規対応: hint_tour_codeに複数の数字列が含まれていても、どちらか一方が一致すれば拾えること
    {
      const sb = makeMockSb({
        booking_costs: [
          { id: 'c7', booking_id: 'b7', amount: 4200, payment_method: 'クレジットカード(法人)', payment_date: '2026-08-10', memo: '' },
        ],
        bookings: [
          { id: 'b7', ref_no: '#1044', tour_name: '1泊 Nagoya', tour_code: null },
        ],
        learned_mappings: [],
        credit_card_statements: [],
      });
      const { findCcMatchCandidates } = await fn(sb);
      const cands = await findCcMatchCandidates({ amount: 4200, hint_tour_code: 'REF#967 TC1044', merchant_name: '★★交通', transaction_date: '2026-08-11' });
      check('結合: 複数の数字列のうち1044のみ一致でもhintMatch=true(新規対応)', cands.length === 1 && cands[0].hintMatch === true, true);
    }

    // 2h) 桁数閾値: 1桁のみの手書きコードは、たとえref_noが同じ1桁でも誤マッチ防止のため
    // hintMatchにはならない(金額一致候補としては引き続き表示される)
    {
      const sb = makeMockSb({
        booking_costs: [
          { id: 'c8', booking_id: 'b8', amount: 1500, payment_method: 'クレジットカード(法人)', payment_date: '2026-08-15', memo: '' },
        ],
        bookings: [
          { id: 'b8', ref_no: '#5', tour_name: '日帰り Nara', tour_code: null },
        ],
        learned_mappings: [],
        credit_card_statements: [],
      });
      const { findCcMatchCandidates } = await fn(sb);
      const cands = await findCcMatchCandidates({ amount: 1500, hint_tour_code: '5-TC', merchant_name: '▲▲食堂', transaction_date: '2026-08-16' });
      check('結合: 1桁のみの手書きコードはhintMatch=false(桁数閾値、誤マッチ防止)', cands.length === 1 && cands[0].hintMatch === false, true);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
