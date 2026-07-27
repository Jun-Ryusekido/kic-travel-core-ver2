// local_expenses(現地費用明細/仮払い一覧表)への書き込み(INSERT/UPDATE/DELETE)専用API。
// anonキーによるlocal_expensesへの直接書き込みをRLSで禁止した後、書き込みは
// すべてこの関数(service_role key)経由で行う。読み取り(select)は従来通り
// anon+RLSのまま変更しない。
//
// booking_sales/booking_costs(/api/booking-sales.js, /api/booking-costs.js)と
// 完全に同じ実装パターンを踏襲する。このアプリはSupabase Authを使わない独自ログイン
// (/api/login)のため、書き込み前にログイン時に発行した署名付きトークン
// (lib/session-token.js、他APIと共通)を検証し、正当なログインユーザーからの
// リクエストであることを確認してから実行する。
import { getServiceKey } from './lib/app-users-db.js';
import { verifySessionToken } from './lib/session-token.js';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';

async function localExpensesFetch(path, opts = {}) {
  const serviceKey = getServiceKey();
  return fetch(`${SB_URL}/rest/v1/local_expenses${path}`, {
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

// PostgRESTが"permission denied for table local_expenses"を返す典型的な原因は、
// RLS/GRANTのロックダウンSQL実行時にservice_roleへのGRANT文が反映されていないケース
// (service_roleはRLSはバイパスするが、テーブル自体へのGRANTが無ければ書き込めない)。
// 原因調査を早くできるよう、その場合だけヒントを付け足す(booking-costs.js等と同じ対策)。
function withGrantHint(message) {
  if (/permission denied for table/i.test(String(message || ''))) {
    return `${message}\n\n（service_roleロールにlocal_expensesへのGRANTが付与されていない可能性があります。Supabase SQL Editorで次を再実行してください: grant select, insert, update, delete on public.local_expenses to service_role; notify pgrst, 'reload schema';）`;
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
    // 「新規INSERTに成功してから、既存の旧行だけをidで指定してDELETEする」安全な差分置き換え。
    // クライアント側のsafeReplaceBookingRowsと同じ考え方(#782の全削除→再挿入事故の再発防止)。
    // 予約詳細モーダル下部の「仮払い一覧表」保存(saveLocalExpenses)から呼ばれる。
    if (action === 'replace') {
      const { bookingId, rows } = req.body;
      if (!bookingId) return res.status(400).json({ error: 'bookingIdが指定されていません' });

      const existingRes = await localExpensesFetch(`?booking_id=eq.${encodeURIComponent(bookingId)}&select=id`);
      if (!existingRes.ok) return res.status(500).json({ error: '既存データの確認に失敗しました' });
      const existing = await existingRes.json();
      const existingIds = (existing || []).map((r) => r.id);

      if (Array.isArray(rows) && rows.length) {
        const insRes = await localExpensesFetch('', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
        if (!insRes.ok) {
          const e = await readJsonSafe(insRes);
          return res.status(500).json({ error: withGrantHint(e.message) || '現地費用明細の保存に失敗しました' });
        }
      }
      if (existingIds.length) {
        const delRes = await localExpensesFetch(`?id=in.(${existingIds.join(',')})`, { method: 'DELETE', prefer: 'return=minimal' });
        if (!delRes.ok) {
          const e = await readJsonSafe(delRes);
          return res.status(500).json({ error: withGrantHint(e.message) || '現地費用明細の旧データ削除に失敗しました（新データは保存済みのため重複している可能性があります）' });
        }
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '不明なactionです' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
