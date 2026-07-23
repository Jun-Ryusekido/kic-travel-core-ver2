// booking_costs(仕入明細)への書き込み(INSERT/UPDATE/DELETE)専用API。
// anonキーによるbooking_costsへの直接書き込みをRLSで禁止した後、書き込みは
// すべてこの関数(service_role key)経由で行う。読み取り(select)は従来通り
// anon+RLSのまま変更しない。
//
// セキュリティ中長期対応フェーズ1のbooking_sales対応(/api/booking-sales.js)と
// 完全に同じ実装パターンを踏襲する。このアプリはSupabase Authを使わない独自ログイン
// (/api/login)のため、書き込み前にログイン時に発行した署名付きトークン
// (lib/session-token.js、booking-sales.jsと共通)を検証し、正当なログインユーザーからの
// リクエストであることを確認してから実行する。
import { getServiceKey } from './lib/app-users-db.js';
import { verifySessionToken } from './lib/session-token.js';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';

async function bookingCostsFetch(path, opts = {}) {
  const serviceKey = getServiceKey();
  return fetch(`${SB_URL}/rest/v1/booking_costs${path}`, {
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

// PostgRESTが"permission denied for table booking_costs"を返す典型的な原因は、
// RLS/GRANTのロックダウンSQL実行時にservice_roleへのGRANT文が反映されていないケース
// (service_roleはRLSはバイパスするが、テーブル自体へのGRANTが無ければ書き込めない)。
// 原因調査を早くできるよう、その場合だけヒントを付け足す(booking-sales.jsと同じ対策)。
function withGrantHint(message) {
  if (/permission denied for table/i.test(String(message || ''))) {
    return `${message}\n\n（service_roleロールにbooking_costsへのGRANTが付与されていない可能性があります。Supabase SQL Editorで次を再実行してください: grant select, insert, update, delete on public.booking_costs to service_role; notify pgrst, 'reload schema';）`;
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
    // 予約詳細モーダル下部の「保存」ボタン押下時(仕入明細タブ全体の保存)に使う。
    if (action === 'replace') {
      const { bookingId, rows } = req.body;
      if (!bookingId) return res.status(400).json({ error: 'bookingIdが指定されていません' });

      const existingRes = await bookingCostsFetch(`?booking_id=eq.${encodeURIComponent(bookingId)}&select=id`);
      if (!existingRes.ok) return res.status(500).json({ error: '既存データの確認に失敗しました' });
      const existing = await existingRes.json();
      const existingIds = (existing || []).map((r) => r.id);

      if (Array.isArray(rows) && rows.length) {
        const insRes = await bookingCostsFetch('', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
        if (!insRes.ok) {
          const e = await readJsonSafe(insRes);
          return res.status(500).json({ error: withGrantHint(e.message) || '仕入明細の保存に失敗しました' });
        }
      }
      if (existingIds.length) {
        const delRes = await bookingCostsFetch(`?id=in.(${existingIds.join(',')})`, { method: 'DELETE', prefer: 'return=minimal' });
        if (!delRes.ok) {
          const e = await readJsonSafe(delRes);
          return res.status(500).json({ error: withGrantHint(e.message) || '仕入明細の旧データ削除に失敗しました（新データは保存済みのため重複している可能性があります）' });
        }
      }
      return res.status(200).json({ ok: true });
    }

    // 単純な追加insertのみの場合(伝票内容の反映・ガイド精算からの反映・OCR読み取り確認後の
    // 保存・請求書読み取りページからの一括保存等、複数の呼び出し元がある)。
    // 複数のbooking_idにまたがる行を一括で渡すケース(請求書読み取りページ)にも対応するため、
    // bookingIdは必須にしない。
    if (action === 'insert') {
      const { rows } = req.body;
      if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: '追加する行がありません' });
      const insRes = await bookingCostsFetch('', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
      if (!insRes.ok) {
        const e = await readJsonSafe(insRes);
        return res.status(500).json({ error: withGrantHint(e.message) || '仕入明細の保存に失敗しました' });
      }
      return res.status(200).json({ ok: true });
    }

    // 予約データの完全削除(deleteBookingData)から呼ばれる、対象予約の仕入明細を全削除する処理。
    if (action === 'deleteByBooking') {
      const { bookingId } = req.body;
      if (!bookingId) return res.status(400).json({ error: 'bookingIdが指定されていません' });
      const delRes = await bookingCostsFetch(`?booking_id=eq.${encodeURIComponent(bookingId)}`, {
        method: 'DELETE', prefer: 'return=minimal',
      });
      if (!delRes.ok) {
        const e = await readJsonSafe(delRes);
        return res.status(500).json({ error: withGrantHint(e.message) || '仕入明細の削除に失敗しました' });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '不明なactionです' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
