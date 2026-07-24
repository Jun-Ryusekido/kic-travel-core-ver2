// parking_reservations(駐車場 今すぐ予約の履歴。支払方法・車両ナンバー・運転手氏名等を含む)
// への読み書き専用API(service_role key経由)。anonキーによる直接select/insert/delete権限を
// 廃止し、一覧取得(list)・新規作成/更新(save)・削除(delete)を1つの関数にまとめて実装する
// (/api/booking-costs.jsのaction分岐と同じパターン。Vercelの関数数上限を無駄に消費しない
// ためlist/save/deleteを別ファイルに分けず1ファイルに統合している)。
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

async function readJsonSafe(resp) {
  try { return await resp.json(); } catch (e) { return {}; }
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

  const { action, token } = req.body || {};
  const session = verifySessionToken(token);
  if (!session) return res.status(401).json({ error: 'ログインセッションが無効です。再度ログインしてください。' });

  try {
    if (action === 'list') {
      const { limit } = req.body;
      const lim = Number(limit) > 0 ? Math.min(Number(limit), 200) : 10;
      const r = await parkingReservationsFetch(`?select=*&order=created_at.desc&limit=${lim}`);
      if (!r.ok) {
        const e = await readJsonSafe(r);
        if (/relation .* does not exist/i.test(e.message || '')) {
          return res.status(200).json({ rows: [], tableMissing: true });
        }
        return res.status(500).json({ error: withGrantHint(e.message) || '一覧の取得に失敗しました' });
      }
      const rows = await r.json();
      return res.status(200).json({ rows });
    }

    if (action === 'save') {
      const { id, payload } = req.body;
      if (!payload || typeof payload !== 'object') return res.status(400).json({ error: '保存する内容がありません' });

      if (id) {
        const r = await parkingReservationsFetch(`?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const e = await readJsonSafe(r);
          return res.status(500).json({ error: withGrantHint(e.message) || '更新に失敗しました' });
        }
        const rows = await r.json();
        return res.status(200).json({ ok: true, row: rows[0] || null });
      }

      const r = await parkingReservationsFetch('', {
        method: 'POST', prefer: 'return=representation', body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await readJsonSafe(r);
        if (/relation .* does not exist/i.test(e.message || '')) {
          return res.status(500).json({ error: 'parking_reservationsテーブルが未作成です。管理者にSupabase側でのテーブル作成を依頼してください。' });
        }
        return res.status(500).json({ error: withGrantHint(e.message) || '登録に失敗しました' });
      }
      const rows = await r.json();
      return res.status(200).json({ ok: true, row: rows[0] || null });
    }

    if (action === 'delete') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'idが指定されていません' });
      const r = await parkingReservationsFetch(`?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE', prefer: 'return=minimal',
      });
      if (!r.ok) {
        const e = await readJsonSafe(r);
        return res.status(500).json({ error: withGrantHint(e.message) || '削除に失敗しました' });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '不明なactionです' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
