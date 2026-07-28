// メール受信箱の「取り込みリスト方式」判定関数。純関数・DBアクセスなし・副作用なし。
// 既存のindex.html内のEMAIL_KIC_CODE_RE/EMAIL_REF_NUMBER_RE/isRoomingListEmailの
// 実装をそのまま再利用し、書き直していない(下記コメントで出典を明記)。
//
// 出典: index.html:8549-8550 (EMAIL_KIC_CODE_RE/EMAIL_REF_NUMBER_RE)
// D-1: 「KIC 770」のような半角スペース区切り表記を実データで75件確認(誤検出0件)したため、
// [-_]? を [-_\s]? に拡張(スペースも区切り文字として許容)。
// STEP3: 「KIC 2026年」「KIC 2026年度」のように直後が年号を示す場合は不一致にするため、
// 否定先読み(?!\s*年度?)を追加。\d{3,4}は元々バックトラック可能な量指定子のため、素直に
// (?!\s*年度?)を直後へ置くだけでは4桁失敗時に3桁へ縮めて再マッチしてしまう
// (「KIC 2026年」→「KIC 202」+「6年」として一致してしまう)。そのためJSにネイティブの
// 所有格量指定子が無い代わりに、(?=(\d{3,4}))\1 の先読み+後方参照で最長一致を固定してから
// 否定先読みを評価する(擬似的な所有格量指定子)。
const EMAIL_KIC_CODE_RE = /\bKIC[-_\s]?(?=(\d{3,4}))\1(?!\s*年度?)(?:_[A-Za-z0-9]+)*/i;
const EMAIL_REF_NUMBER_RE = /(?:(?<![&\w\/=%.:~#-])#\s*(\d{3,}))|(?:\bREF\s*#?\s*(\d{3,}))/gi;

// D-2: bookings.tour_codeの実データ(387件のdistinct値のうち311件が「KIC####_接尾辞」形式に
// 一致)から接尾辞を抽出し、実在する30種類のみをホワイトリスト化した(推測で決めていない)。
// 区切り文字(-または_)を必須にし、"KIC"単体・"KIC Travel"等の自社名では絶対に一致しない
// ようにしている。実測の結果、この拡張だけでの新規一致は0件(D-1の拡張と全て重複)だったが、
// 将来「シリーズ名のみで数字が本文のどこにも登場しない」メールが来た場合の保険として残す。
const EMAIL_KIC_SERIES_SUFFIXES = ['TC','KK','JF','JA','NEX','JJ','TBO','AKB','DP','J1','SI','JK','TEH','ORN','AT','TCX','ANG','JE','SUN','LJ','TWO','SLT','JB','TWD','LF','EVT','ZJ','TL','TM','IT'];
const EMAIL_KIC_SERIES_RE = new RegExp('\\bKIC[-_](' + EMAIL_KIC_SERIES_SUFFIXES.join('|') + ')\\b', 'i');

// 出典: index.html:8879-8888 (EMAIL_ROOMING_LIST_KEYWORDS_JA/EMAIL_ROOMING_LIST_WORD_PATTERNS_EN/isRoomingListEmail)
// ユーザー指示の追加候補(部屋割/PAX list/参加者リスト)をキーワードに追加している点のみ差分。
const EMAIL_ROOMING_LIST_KEYWORDS_JA = ['ルーミングリスト', 'ルーミング', '名簿', '参加者名簿', '乗客名簿', '搭乗者名簿', '宿泊者名簿', '部屋割', '参加者リスト'];
const EMAIL_ROOMING_LIST_WORD_PATTERNS_EN = [
  /\brooming\s*list\b/i, /\broom\s*list\b/i, /\bname\s*list\b/i, /\bpax\s*list\b/i,
  /\bpassenger\s*list\b/i, /\bfinal\s*list\b/i, /\bguest\s*list\b/i,
];

function normalizeText(s) {
  // 全角英数字・記号を半角に、全角スペースを半角スペースに正規化してから判定する。
  return String(s || '').normalize('NFKC');
}

function hasKicCode(text) {
  return EMAIL_KIC_CODE_RE.test(text) || EMAIL_KIC_SERIES_RE.test(text);
}

function matchedKicCode(text) {
  const m = text.match(EMAIL_KIC_CODE_RE);
  if (m) return m[0];
  const m2 = text.match(EMAIL_KIC_SERIES_RE);
  return m2 ? m2[0] : '';
}

function knownRefMatches(text, refSet) {
  const candidates = [];
  EMAIL_REF_NUMBER_RE.lastIndex = 0;
  let m;
  while ((m = EMAIL_REF_NUMBER_RE.exec(text))) {
    candidates.push(m[1] || m[2]);
  }
  if (!candidates.length || !refSet || refSet.size === 0) return null;
  return candidates.find(c => refSet.has(c)) || null;
}

function isRoomingListEmail(text) {
  if (EMAIL_ROOMING_LIST_KEYWORDS_JA.some(k => text.includes(k))) {
    return EMAIL_ROOMING_LIST_KEYWORDS_JA.find(k => text.includes(k));
  }
  const p = EMAIL_ROOMING_LIST_WORD_PATTERNS_EN.find(re => re.test(text));
  if (p) { const m = text.match(p); return m ? m[0] : p.source; }
  return null;
}

// classifyEmail: 純関数。DBアクセス・副作用一切なし。
// refSet: bookings.ref_no を "#" を除去した文字列でSetにしたもの(呼び出し側が事前ロードして渡す)。
// attachmentNames: 現状のemail_import_queueには添付ファイル名が保存されていないため常に空配列
//   を想定するが、引数としては残す(将来添付名が取得可能になった場合の拡張点)。
function classifyEmail({ subject, body, attachmentNames, refSet }) {
  const text = normalizeText((subject || '') + ' ' + (body || '') + ' ' + ((attachmentNames || []).join(' ')));

  const kic = matchedKicCode(text);
  if (kic) {
    return { isImport: true, reason: 'kic_code', matched: kic };
  }

  const refMatch = knownRefMatches(text, refSet);
  if (refMatch) {
    return { isImport: true, reason: 'ref_no', matched: refMatch };
  }

  const roomingMatch = isRoomingListEmail(text);
  if (roomingMatch) {
    return { isImport: true, reason: 'name_list', matched: roomingMatch };
  }

  return { isImport: false, reason: 'none', matched: '' };
}

module.exports = { classifyEmail, EMAIL_KIC_CODE_RE, EMAIL_KIC_SERIES_RE, EMAIL_KIC_SERIES_SUFFIXES, EMAIL_REF_NUMBER_RE, EMAIL_ROOMING_LIST_KEYWORDS_JA, EMAIL_ROOMING_LIST_WORD_PATTERNS_EN };
