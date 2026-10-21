// audit_logs(変更履歴)に保存する/返す行から、機密項目(マイナンバー等)の値を取り除く。
// TABLE_CONFIG[table].auditRedactFields に列名を挙げたテーブルが対象。
// 値そのものは保存も返却もせず、「値があるか」「この変更で値が変わったか」だけを残す
// (変更履歴の差分表示は before/after をJSON比較するため、変更ありの場合は after 側の
// 文言を変えて「変更あり」が画面上で分かるようにしている)。
export const AUDIT_REDACT_MARK = '(マイナンバー・値は非保存)';
export const AUDIT_REDACT_CHANGED_MARK = '(マイナンバー・値は非保存・変更あり)';

function isEmptyValue(v) {
  return v === null || v === undefined || v === '';
}

function isRedactMark(v) {
  return v === AUDIT_REDACT_MARK || v === AUDIT_REDACT_CHANGED_MARK;
}

// before/after(行オブジェクトまたはnull)のうち、fields に挙げた列の値を伏せ字に置換した
// 新しいオブジェクトを返す(引数は書き換えない)。既に伏せ字に置換済みの値(過去に
// このマスク後に保存された行)はそのまま保持する。
export function redactAuditPair(before, after, fields) {
  if (!Array.isArray(fields) || !fields.length) return { before, after };
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  const b = isObj(before) ? { ...before } : before;
  const a = isObj(after) ? { ...after } : after;
  for (const f of fields) {
    const bHas = isObj(b) && Object.prototype.hasOwnProperty.call(b, f);
    const aHas = isObj(a) && Object.prototype.hasOwnProperty.call(a, f);
    if (!bHas && !aHas) continue;
    const bv = bHas ? b[f] : undefined;
    const av = aHas ? a[f] : undefined;
    // 既にマスク済みの値が入っている行(保存時マスク後の行)は、そのまま信頼する。
    if (isRedactMark(bv) || isRedactMark(av)) continue;
    const changed = bHas && aHas && !isEmptyValue(bv) && !isEmptyValue(av) && String(bv) !== String(av);
    if (bHas && !isEmptyValue(bv)) b[f] = AUDIT_REDACT_MARK;
    if (aHas && !isEmptyValue(av)) a[f] = changed ? AUDIT_REDACT_CHANGED_MARK : AUDIT_REDACT_MARK;
  }
  return { before: b, after: a };
}
