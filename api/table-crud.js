// service_role key経由の汎用テーブル操作API。
//
// これまでbooking-sales.js/booking-costs.js/local-expenses.js/parking-reservations.jsの
// 4ファイルに分かれていた「anonロールの直接書き込みを禁止し、ログイン済みユーザーからの
// リクエストのみservice_role keyで書き込みを許可する」という全く同じ実装パターンを、
// Vercel Hobbyプランのサーバーレス関数数上限(12個)対策として1ファイルに統合したもの。
//
// セキュリティ上の見通しを保つため、統合後も「どのテーブルに」「どのactionが」許可されて
// いるかをTABLE_CONFIGで明示的にホワイトリスト化している(bodyのtable名をそのままクエリに
// 埋め込んで任意テーブルを操作できるような実装にはしていない)。各テーブル・action固有の
// バリデーション/レスポンス形状は、移行前の各ファイルの実装をそのまま踏襲する。
import { getServiceKey } from './lib/app-users-db.js';
import { verifySessionToken } from './lib/session-token.js';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';

// テーブルごとに許可するactionをホワイトリスト化する。ここに無い(table, action)の
// 組み合わせは400で拒否する。
const TABLE_CONFIG = {
  booking_sales: { actions: ['replace', 'updatePayments', 'deleteByBooking'], label: '売上明細' },
  booking_costs: { actions: ['replace', 'insert', 'deleteByBooking'], label: '仕入明細' },
  local_expenses: { actions: ['replace'], label: '現地費用明細' },
  parking_reservations: { actions: ['list', 'save', 'delete'], label: '駐車場予約' },
};

function sbFetch(table, path, opts = {}) {
  const serviceKey = getServiceKey();
  return fetch(`${SB_URL}/rest/v1/${table}${path}`, {
    ...opts,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

async function readJsonSafe(resp) {
  try { return await resp.json(); } catch (e) { return {}; }
}

// PostgRESTが"permission denied for table xxx"を返す典型的な原因は、RLS/GRANTの
// ロックダウンSQL実行時にservice_roleへのGRANT文が反映されていないケース
// (service_roleはRLSはバイパスするが、テーブル自体へのGRANTが無ければ書き込めない)。
// 原因調査を早くできるよう、その場合だけヒントを付け足す(移行前の各ファイルと同じ対策)。
function withGrantHint(message, table) {
  if (/permission denied for table/i.test(String(message || ''))) {
    return `${message}\n\n（service_roleロールに${table}へのGRANTが付与されていない可能性があります。Supabase SQL Editorで次を再実行してください: grant select, insert, update, delete on public.${table} to service_role; notify pgrst, 'reload schema';）`;
  }
  return message;
}

// 「新規INSERTに成功してから、既存の旧行だけをidで指定してDELETEする」安全な差分置き換え。
// クライアント側のsafeReplaceBookingRowsと同じ考え方(#782の全削除→再挿入事故の再発防止)。
async function doReplace(table, label, bookingId, rows) {
  if (!bookingId) return { status: 400, body: { error: 'bookingIdが指定されていません' } };

  const existingRes = await sbFetch(table, `?booking_id=eq.${encodeURIComponent(bookingId)}&select=id`);
  if (!existingRes.ok) return { status: 500, body: { error: '既存データの確認に失敗しました' } };
  const existing = await existingRes.json();
  const existingIds = (existing || []).map((r) => r.id);

  if (Array.isArray(rows) && rows.length) {
    const insRes = await sbFetch(table, '', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
    if (!insRes.ok) {
      const e = await readJsonSafe(insRes);
      return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の保存に失敗しました` } };
    }
  }
  if (existingIds.length) {
    const delRes = await sbFetch(table, `?id=in.(${existingIds.join(',')})`, { method: 'DELETE', prefer: 'return=minimal' });
    if (!delRes.ok) {
      const e = await readJsonSafe(delRes);
      return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の旧データ削除に失敗しました（新データは保存済みのため重複している可能性があります）` } };
    }
  }
  return { status: 200, body: { ok: true } };
}

async function doInsert(table, label, rows) {
  if (!Array.isArray(rows) || !rows.length) return { status: 400, body: { error: '追加する行がありません' } };
  const insRes = await sbFetch(table, '', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
  if (!insRes.ok) {
    const e = await readJsonSafe(insRes);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の保存に失敗しました` } };
  }
  return { status: 200, body: { ok: true } };
}

async function doDeleteByBooking(table, label, bookingId) {
  if (!bookingId) return { status: 400, body: { error: 'bookingIdが指定されていません' } };
  const delRes = await sbFetch(table, `?booking_id=eq.${encodeURIComponent(bookingId)}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!delRes.ok) {
    const e = await readJsonSafe(delRes);
    return { status: 500, body: { error: withGrantHint(e.message, table) || `${label}の削除に失敗しました` } };
  }
  return { status: 200, body: { ok: true } };
}

// booking_sales専用: 入金消込(通帳OCRの自動マッチング等)で、既存1行のpaymentsのみを更新する。
async function doUpdatePayments(table, rowId, payments) {
  if (!rowId) return { status: 400, body: { error: 'rowIdが指定されていません' } };
  const upRes = await sbFetch(table, `?id=eq.${encodeURIComponent(rowId)}`, {
    method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ payments }),
  });
  if (!upRes.ok) {
    const e = await readJsonSafe(upRes);
    return { status: 500, body: { error: withGrantHint(e.message, table) || '入金反映に失敗しました' } };
  }
  return { status: 200, body: { ok: true } };
}

// parking_reservations専用: 一覧取得。テーブル未作成時はエラーにせず空配列を返す
// (移行前のparking-reservations.jsと同じフォールバック挙動)。
async function doParkingList(table, limit) {
  const lim = Number(limit) > 0 ? Math.min(Number(limit), 200) : 10;
  const r = await sbFetch(table, `?select=*&order=created_at.desc&limit=${lim}`);
  if (!r.ok) {
    const e = await readJsonSafe(r);
    if (/relation .* does not exist/i.test(e.message || '')) return { status: 200, body: { rows: [], tableMissing: true } };
    return { status: 500, body: { error: withGrantHint(e.message, table) || '一覧の取得に失敗しました' } };
  }
  const rows = await r.json();
  return { status: 200, body: { rows } };
}

// parking_reservations専用: idがあれば更新、なければ新規作成(upsert)。
async function doParkingSave(table, id, payload) {
  if (!payload || typeof payload !== 'object') return { status: 400, body: { error: '保存する内容がありません' } };

  if (id) {
    const r = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const e = await readJsonSafe(r);
      return { status: 500, body: { error: withGrantHint(e.message, table) || '更新に失敗しました' } };
    }
    const rows = await r.json();
    return { status: 200, body: { ok: true, row: rows[0] || null } };
  }

  const r = await sbFetch(table, '', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(payload) });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    if (/relation .* does not exist/i.test(e.message || '')) {
      return { status: 500, body: { error: `${table}テーブルが未作成です。管理者にSupabase側でのテーブル作成を依頼してください。` } };
    }
    return { status: 500, body: { error: withGrantHint(e.message, table) || '登録に失敗しました' } };
  }
  const rows = await r.json();
  return { status: 200, body: { ok: true, row: rows[0] || null } };
}

async function doParkingDelete(table, id) {
  if (!id) return { status: 400, body: { error: 'idが指定されていません' } };
  const r = await sbFetch(table, `?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) {
    const e = await readJsonSafe(r);
    return { status: 500, body: { error: withGrantHint(e.message, table) || '削除に失敗しました' } };
  }
  return { status: 200, body: { ok: true } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const { table, action, token } = req.body || {};
  const session = verifySessionToken(token);
  if (!session) return res.status(401).json({ error: 'ログインセッションが無効です。再度ログインしてください。' });

  const config = TABLE_CONFIG[table];
  if (!config) return res.status(400).json({ error: `不明なtableです: ${table}` });
  if (!config.actions.includes(action)) return res.status(400).json({ error: `${table}に対して許可されていないactionです: ${action}` });

  try {
    if (action === 'replace') {
      const { bookingId, rows } = req.body;
      const result = await doReplace(table, config.label, bookingId, rows);
      return res.status(result.status).json(result.body);
    }
    if (action === 'insert') {
      const { rows } = req.body;
      const result = await doInsert(table, config.label, rows);
      return res.status(result.status).json(result.body);
    }
    if (action === 'deleteByBooking') {
      const { bookingId } = req.body;
      const result = await doDeleteByBooking(table, config.label, bookingId);
      return res.status(result.status).json(result.body);
    }
    if (action === 'updatePayments') {
      const { rowId, payments } = req.body;
      const result = await doUpdatePayments(table, rowId, payments);
      return res.status(result.status).json(result.body);
    }
    if (action === 'list') {
      const { limit } = req.body;
      const result = await doParkingList(table, limit);
      return res.status(result.status).json(result.body);
    }
    if (action === 'save') {
      const { id, payload } = req.body;
      const result = await doParkingSave(table, id, payload);
      return res.status(result.status).json(result.body);
    }
    if (action === 'delete') {
      const { id } = req.body;
      const result = await doParkingDelete(table, id);
      return res.status(result.status).json(result.body);
    }

    return res.status(400).json({ error: '不明なactionです' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
