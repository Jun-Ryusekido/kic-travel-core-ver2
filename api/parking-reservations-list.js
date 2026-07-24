// parking_reservations(駐車場 今すぐ予約の履歴)の一覧取得専用API。
// このテーブルは支払方法・車両ナンバー・運転手氏名等の個人情報を含むため、
// anonキーによる直接select/insert/delete権限を廃止し、読み書きすべてをこの関数群
// (service_role key)経由に統一する。/api/booking-costs.js等と同じ実装パターンを踏襲する。
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

  const { token, limit } = req.body || {};
  const session = verifySessionToken(token);
  if (!session) return res.status(401).json({ error: 'ログインセッションが無効です。再度ログインしてください。' });

  try {
    const lim = Number(limit) > 0 ? Math.min(Number(limit), 200) : 10;
    const r = await parkingReservationsFetch(`?select=*&order=created_at.desc&limit=${lim}`);
    if (!r.ok) {
      const e = await (async () => { try { return await r.json(); } catch (_) { return {}; } })();
      if (/relation .* does not exist/i.test(e.message || '')) {
        return res.status(200).json({ rows: [], tableMissing: true });
      }
      return res.status(500).json({ error: withGrantHint(e.message) || '一覧の取得に失敗しました' });
    }
    const rows = await r.json();
    return res.status(200).json({ rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
