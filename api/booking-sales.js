// booking_sales(売上明細)への書き込み(INSERT/UPDATE/DELETE)専用API。
// anonキーによるbooking_salesへの直接書き込みをRLSで禁止した後、書き込みは
// すべてこの関数(service_role key)経由で行う。読み取り(select)は従来通り
// anon+RLSのまま変更しない。
//
// このアプリはSupabase Authを使わない独自ログイン(/api/login)のため、書き込み前に
// ログイン時に発行した署名付きトークン(lib/session-token.js)を検証し、正当な
// ログインユーザーからのリクエストであることを確認してから実行する。
import { getServiceKey } from './lib/app-users-db.js';
import { verifySessionToken } from './lib/session-token.js';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';

async function bookingSalesFetch(path, opts = {}) {
  const serviceKey = getServiceKey();
  return fetch(`${SB_URL}/rest/v1/booking_sales${path}`, {
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const { action, token } = req.body || {};
  const session = verifySessionToken(token);
  if (!session) return res.status(401).json({ error: 'ログインセッションが無効です。再度ログインしてください。' });

  try {
    // 「新規INSERTに成功してから、既存の旧行だけをidで指定してDELETEする」安全な差分置き換え。
    // クライアント側のsafeReplaceBookingRowsと同じ考え方(#782の全削除→再挿入事故の再発防止)。
    if (action === 'replace') {
      const { bookingId, rows } = req.body;
      if (!bookingId) return res.status(400).json({ error: 'bookingIdが指定されていません' });

      const existingRes = await bookingSalesFetch(`?booking_id=eq.${encodeURIComponent(bookingId)}&select=id`);
      if (!existingRes.ok) return res.status(500).json({ error: '既存データの確認に失敗しました' });
      const existing = await existingRes.json();
      const existingIds = (existing || []).map((r) => r.id);

      if (Array.isArray(rows) && rows.length) {
        const insRes = await bookingSalesFetch('', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
        if (!insRes.ok) {
          const e = await readJsonSafe(insRes);
          return res.status(500).json({ error: e.message || '売上明細の保存に失敗しました' });
        }
      }
      if (existingIds.length) {
        const delRes = await bookingSalesFetch(`?id=in.(${existingIds.join(',')})`, { method: 'DELETE', prefer: 'return=minimal' });
        if (!delRes.ok) {
          const e = await readJsonSafe(delRes);
          return res.status(500).json({ error: e.message || '売上明細の旧データ削除に失敗しました（新データは保存済みのため重複している可能性があります）' });
        }
      }
      return res.status(200).json({ ok: true });
    }

    // 入金消込(通帳OCRの自動マッチング等)で、既存1行のpaymentsのみを更新する場合。
    if (action === 'updatePayments') {
      const { rowId, payments } = req.body;
      if (!rowId) return res.status(400).json({ error: 'rowIdが指定されていません' });
      const upRes = await bookingSalesFetch(`?id=eq.${encodeURIComponent(rowId)}`, {
        method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ payments }),
      });
      if (!upRes.ok) {
        const e = await readJsonSafe(upRes);
        return res.status(500).json({ error: e.message || '入金反映に失敗しました' });
      }
      return res.status(200).json({ ok: true });
    }

    // 予約データの完全削除(deleteBookingData)から呼ばれる、対象予約の売上明細を全削除する処理。
    if (action === 'deleteByBooking') {
      const { bookingId } = req.body;
      if (!bookingId) return res.status(400).json({ error: 'bookingIdが指定されていません' });
      const delRes = await bookingSalesFetch(`?booking_id=eq.${encodeURIComponent(bookingId)}`, {
        method: 'DELETE', prefer: 'return=minimal',
      });
      if (!delRes.ok) {
        const e = await readJsonSafe(delRes);
        return res.status(500).json({ error: e.message || '売上明細の削除に失敗しました' });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '不明なactionです' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
