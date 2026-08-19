// Outlookからのメール取り込み(email-automation/catchup-missed-mail.ps1、JUNさんのPCで
// Windowsタスクスケジューラにより定期実行)専用の書き込みエンドポイント。
//
// email_import_queueは本文(body)を含む機微なテーブルのため、
// scripts/lock_down_email_import_queue_writes.sqlによりanon/authenticatedからの
// INSERT/UPDATE/DELETEを剥奪済み(SELECTのみ残す)。この結果、catchup-missed-mail.ps1が
// 直接anonキーでINSERTしていた経路が失敗するようになった(2026-08-06以降のメール
// 未取り込み障害の原因)。
//
// このスクリプトはブラウザのログインセッションを持たない(Windowsタスクスケジューラから
// 無人実行される)ため、/api/table-crud.jsのセッショントークン認証は使えない。代わりに
// 固定の共有シークレット(x-import-keyヘッダー)で認証する、この用途専用の狭いエンドポイント
// にした(table-crud.jsの汎用アクションホワイトリストに insert を追加する形にはしなかった。
// 認証方式が全く異なるため、既存の全テーブル共通の認証ロジックに機械認証の特例を混ぜたく
// なかったため)。
//
// EMAIL_IMPORT_API_KEY・SUPABASE_SERVICE_ROLE_KEYは共にVercelの環境変数で設定すること。
// EMAIL_IMPORT_API_KEYはcatchup-missed-mail.ps1側にも同じ値をレジストリ経由で設定する
// (git管理下のファイルには平文で書かない)。

import { getServiceKey } from './lib/app-users-db.js';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const MAX_ROWS_PER_REQUEST = 500;

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const serviceKey = getServiceKey();
  if (!serviceKey) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const expectedKey = process.env.EMAIL_IMPORT_API_KEY || '';
  if (!expectedKey) return res.status(500).json({ error: 'サーバー側にEMAIL_IMPORT_API_KEYが設定されていません' });

  const providedKey = req.headers['x-import-key'] || '';
  if (!timingSafeEqual(String(providedKey), expectedKey)) {
    return res.status(401).json({ error: '認証に失敗しました（x-import-keyが不正です）' });
  }

  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || rows.length === 0) return res.status(400).json({ error: 'rowsが空です' });
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    return res.status(400).json({ error: `1リクエストあたり最大${MAX_ROWS_PER_REQUEST}件までです（${rows.length}件指定）` });
  }

  // クライアントが送ってきた値のうち、この6列だけを取り出してinsertする
  // (任意の列を書き込めるようにはしない)。html_body/attachmentsは2026-08-14に
  // email_import_queueへ追加された列(html_body: メール受信箱の赤字/強調表記検知に使う
  // HTML本文、attachments: Supabase Storageへアップロード済みの添付ファイル情報の配列)。
  const sanitized = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') return res.status(400).json({ error: 'rowsの形式が不正です' });
    const { subject, body: mailBody, sender, received_at, html_body, attachments } = r;
    if (typeof sender !== 'string' || !sender) return res.status(400).json({ error: 'senderは必須です' });
    if (typeof received_at !== 'string' || !received_at) return res.status(400).json({ error: 'received_atは必須です' });
    // html_bodyはVBA側で既に50,000文字に切り詰め済みだが、サーバー側でも念のため
    // 二重に切り詰める(呼び出し元がVBA以外に増えた場合の安全策)。
    const cappedHtmlBody = typeof html_body === 'string' ? html_body.slice(0, 50000) : '';
    sanitized.push({
      subject: typeof subject === 'string' ? subject : '',
      body: typeof mailBody === 'string' ? mailBody : '',
      sender,
      received_at,
      html_body: cappedHtmlBody,
      attachments: Array.isArray(attachments) ? attachments : [],
    });
  }

  try {
    // subject+sender+received_atの一意制約(email_import_queue_subject_sender_received_at_key)
    // にon_conflictでupsertする。catchup-missed-mail.ps1がLastCheck更新前に中断される等で
    // 同じメールが二重送信された場合でも、ここでDB側が最終防衛線として重複INSERTを弾く。
    // resolution=ignore-duplicatesを使うのは、衝突した既存行(imported/ignored等の運用フラグが
    // 既に乗っている可能性がある)を誤って上書きしないため(merge-duplicatesは使わない)。
    const insRes = await fetch(
      `${SB_URL}/rest/v1/email_import_queue?on_conflict=subject,sender,received_at`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal, resolution=ignore-duplicates',
        },
        body: JSON.stringify(sanitized),
      }
    );
    if (!insRes.ok) {
      const text = await insRes.text().catch(() => '');
      return res.status(502).json({ error: `Supabaseへの書き込みに失敗しました: ${insRes.status} ${text}` });
    }
    return res.status(200).json({ ok: true, inserted: sanitized.length });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
