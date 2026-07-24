// parking_reservationsの削除専用API(service_role key経由)。
// /api/booking-costs.js等と同じ実装パターン(セッショントークン検証)を踏襲する。
import { getServiceKey } from './lib/app-users-db.js';
import { verifySessionToken } from './lib/session-token.js';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';

async function parkingReservationsFetch(path, opts = {}) {
  const serviceKey = getServiceKey();
  return fetch(`${SB_URL}/rest/v1/parking_reservations${path}`, {
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

function withGrantHint(message) {
  if (/permission denied for table/i.test(String(message || ''))) {
    return `${message}\n\n（service_roleロールにparking_reservationsへのGRANTが付与されていない可能性があります。Supabase SQL Editorで次を再実行してください: grant select, insert, update, delete on public.parking_reservations to service_role; notify pgrst, 'reload schema';）`;
  }
  return message;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const { token, id } = req.body || {};
  const session = verifySessionToken(token);
  if (!session) return res.status(401).json({ error: 'ログインセッションが無効です。再度ログインしてください。' });
  if (!id) return res.status(400).json({ error: 'idが指定されていません' });

  try {
    const r = await parkingReservationsFetch(`?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE', prefer: 'return=minimal',
    });
    if (!r.ok) {
      const e = await (async () => { try { return await r.json(); } catch (_) { return {}; } })();
      return res.status(500).json({ error: withGrantHint(e.message) || '削除に失敗しました' });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
