// 変更履歴(audit_logs)のマイナンバー伏せ字化の検証。api/table-crud.jsの本物のhandlerを、
// fetchを差し替えたメモリ上の疑似Supabase+合成データで実行する(ネットワーク・実DBには触れない)。
//   node scripts/test_audit_redact.js
// ダミー値はすべて合成。実在しない番号を使い、結果の出力にも値は出さない。
import assert from 'node:assert/strict';

process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-key-for-test';
const { issueSessionToken } = await import('../api/lib/session-token.js');
const { default: handler } = await import('../api/table-crud.js');
const { redactAuditPair, AUDIT_REDACT_MARK, AUDIT_REDACT_CHANGED_MARK } = await import('../api/lib/audit-redact.js');

const SECRET_A = '111122223333'; // 合成値
const SECRET_B = '999988887777'; // 合成値
const db = { guides: [{ id: 'g1', name: 'テスト太郎', bank_info: 'x', my_number: SECRET_A }], audit_logs: [] };
// 既存(マスク導入前)の平文行を再現
db.audit_logs.push({ id: 1, table_name: 'guides', record_id: 'g1', action: 'update', changed_by: 't@x', changed_at: '2026-01-01T00:00:00Z',
  before_data: { id: 'g1', name: 'テスト太郎', my_number: null }, after_data: { id: 'g1', name: 'テスト太郎', my_number: SECRET_A } });

let nextId = 100;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const table = u.pathname.split('/').pop();
  const method = opts.method || 'GET';
  const json = (data) => { const copy = JSON.parse(JSON.stringify(data)); return { ok: true, status: 200, json: async () => copy, text: async () => JSON.stringify(copy) }; };
  if (table === 'guides' && method === 'GET') return json(db.guides.filter((g) => u.searchParams.get('id') === `eq.${g.id}`));
  if (table === 'guides' && method === 'PATCH') {
    const g = db.guides.find((x) => u.searchParams.get('id') === `eq.${x.id}`);
    Object.assign(g, JSON.parse(opts.body));
    return json([{ ...g }]);
  }
  if (table === 'audit_logs' && method === 'POST') {
    JSON.parse(opts.body).forEach((r) => db.audit_logs.push({ id: nextId++, changed_at: new Date().toISOString(), ...r }));
    return json([]);
  }
  if (table === 'audit_logs' && method === 'GET') {
    return json(db.audit_logs.filter((r) => u.searchParams.get('table_name') === `eq.${r.table_name}` && u.searchParams.get('record_id') === `eq.${r.record_id}`));
  }
  throw new Error('unexpected fetch ' + method + ' ' + table);
};

const token = issueSessionToken({ email: 'tester@example.com', role: 'staff' });
async function call(body) {
  let status = 0, out;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(b) { out = b; return this; }, end() {} };
  await handler({ method: 'POST', headers: { 'x-app-version': '2999999999' }, query: {}, body: { token, ...body } }, res);
  return { status, out };
}

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('OK   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ' :: ' + e.message.split('\n')[0]); } };
const dump = () => JSON.stringify(db.audit_logs.slice(1)); // 新規に保存された行(既存の平文行を除く)

// 1) my_number を変更して保存 → audit_logs に新しい値も古い値も入らない
const r1 = await call({ table: 'guides', action: 'updateById', id: 'g1', fields: { my_number: SECRET_B } });
check('updateById成功', () => assert.equal(r1.status, 200));
check('保存されたaudit_logsに平文(新旧)が含まれない', () => { const d = dump(); assert(!d.includes(SECRET_A) && !d.includes(SECRET_B)); });
const saved = db.audit_logs[db.audit_logs.length - 1];
check('値変更は「変更あり」の伏せ字で分かる', () => { assert.equal(saved.before_data.my_number, AUDIT_REDACT_MARK); assert.equal(saved.after_data.my_number, AUDIT_REDACT_CHANGED_MARK); });
check('guides本体の値は更新されている(監査ログのみ伏せる)', () => assert.equal(db.guides[0].my_number, SECRET_B));

// 2) my_number以外の列だけ変更 → my_numberは「同じ伏せ字」で差分に出ない
await call({ table: 'guides', action: 'updateById', id: 'g1', fields: { bank_info: 'y' } });
const saved2 = db.audit_logs[db.audit_logs.length - 1];
check('他列のみの更新では my_number が同一の伏せ字(差分なし)', () => assert.equal(saved2.before_data.my_number, saved2.after_data.my_number));
check('他列の差分は従来どおり記録される', () => { assert.equal(saved2.before_data.bank_info, 'x'); assert.equal(saved2.after_data.bank_info, 'y'); });
check('2回目の保存後も平文なし', () => { const d = dump(); assert(!d.includes(SECRET_A) && !d.includes(SECRET_B)); });

// 3) 変更履歴の返却: 過去の平文行もマスクされて返る
const h = await call({ table: 'guides', action: 'auditHistory', recordId: 'g1' });
check('auditHistory成功', () => assert.equal(h.status, 200));
check('返却JSONに平文(新旧)が含まれない(過去の平文行も含む)', () => { const d = JSON.stringify(h.out); assert(!d.includes(SECRET_A) && !d.includes(SECRET_B)); });
const legacy = h.out.rows.find((r) => r.id === 1);
check('過去の平文行は 空→伏せ字 として返る', () => { assert.equal(legacy.before_data.my_number, null); assert.equal(legacy.after_data.my_number, AUDIT_REDACT_MARK); });
check('DB上の既存audit_logs行は書き換えていない', () => assert.equal(db.audit_logs[0].after_data.my_number, SECRET_A));

// 4) ヘルパー単体
check('insert(before=null)', () => { const r = redactAuditPair(null, { my_number: SECRET_A }, ['my_number']); assert.equal(r.before, null); assert.equal(r.after.my_number, AUDIT_REDACT_MARK); });
check('delete(after=null)', () => { const r = redactAuditPair({ my_number: SECRET_A }, null, ['my_number']); assert.equal(r.before.my_number, AUDIT_REDACT_MARK); assert.equal(r.after, null); });
check('値→空 は 伏せ字→空', () => { const r = redactAuditPair({ my_number: SECRET_A }, { my_number: null }, ['my_number']); assert.equal(r.before.my_number, AUDIT_REDACT_MARK); assert.equal(r.after.my_number, null); });
check('対象外テーブル(fields未指定)は素通し', () => { const b = { my_number: SECRET_A }; const r = redactAuditPair(b, b, undefined); assert.equal(r.before, b); });
check('引数を書き換えない', () => { const b = { my_number: SECRET_A }; redactAuditPair(b, null, ['my_number']); assert.equal(b.my_number, SECRET_A); });
check('マスク済み行は二重に変換しない', () => { const r = redactAuditPair({ my_number: AUDIT_REDACT_MARK }, { my_number: AUDIT_REDACT_CHANGED_MARK }, ['my_number']); assert.equal(r.before.my_number, AUDIT_REDACT_MARK); assert.equal(r.after.my_number, AUDIT_REDACT_CHANGED_MARK); });

console.log(`\n${pass}件成功 / ${fail}件失敗`);
process.exit(fail ? 1 : 0);
