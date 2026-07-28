// メール受信箱の「取り込みリスト方式」判定関数。純関数・DBアクセスなし・副作用なし。
// 既存のindex.html内のEMAIL_KIC_CODE_RE/EMAIL_REF_NUMBER_RE/isRoomingListEmailの
// 実装をそのまま再利用し、書き直していない(下記コメントで出典を明記)。
//
// 出典: index.html:8549-8550 (EMAIL_KIC_CODE_RE/EMAIL_REF_NUMBER_RE)
const EMAIL_KIC_CODE_RE = /\bKIC[-_]?\d{3,4}(?:_[A-Za-z0-9]+)*/i;
const EMAIL_REF_NUMBER_RE = /(?:(?<![&\w\/=%.:~#-])#\s*(\d{3,}))|(?:\bREF\s*#?\s*(\d{3,}))/gi;

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
  return EMAIL_KIC_CODE_RE.test(text);
}

function matchedKicCode(text) {
  const m = text.match(EMAIL_KIC_CODE_RE);
  return m ? m[0] : '';
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

module.exports = { classifyEmail, EMAIL_KIC_CODE_RE, EMAIL_REF_NUMBER_RE, EMAIL_ROOMING_LIST_KEYWORDS_JA, EMAIL_ROOMING_LIST_WORD_PATTERNS_EN };
