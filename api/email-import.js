// Outlookからのメール取り込み専用エンドポイント。VBAマクロ
// (email-automation/exports/2026-08-14/Module1_updated.bas)とWindowsタスクスケジューラ
// (email-automation/catchup-missed-mail.ps1)から、ブラウザのログインセッションを持たない
// 無人実行で直接叩かれる。/api/table-crud.jsのセッショントークン認証は使えないため、
// 固定の共有シークレット(x-import-keyヘッダー)で認証する専用の狭いエンドポイントに
// している(table-crud.jsの汎用アクションホワイトリストに混ぜず、認証方式が全く異なる
// この用途だけ独立させている)。
//
// 2026-08-22、Vercel Hobbyプランの関数数上限(12本)対策(フェーズ1)のため、旧
// api/email-import-insert.js(メール本文のDB取込・重複チェック)と
// api/email-attachment-upload.js(添付ファイルのSupabase Storageアップロード)を
// 1ファイルに統合した。どちらもNode runtime・x-import-key認証・呼び出し元がVBA/PS1の
// みという同一の性質のグループのため。vercel.jsonのrewritesで従来のURL
// (/api/email-import-insert, /api/email-attachment-upload)はそのまま維持しており、
// VBA/PS1側の変更は一切不要(?legacyModeクエリパラメータでこのファイル内の処理を
// 振り分ける、api/table-crud.jsのlegacyTableと同じ方式)。
//
// EMAIL_IMPORT_API_KEY・SUPABASE_SERVICE_ROLE_KEYは共にVercelの環境変数で設定すること。
// EMAIL_IMPORT_API_KEYはcatchup-missed-mail.ps1側にも同じ値をレジストリ経由で設定する
// (git管理下のファイルには平文で書かない)。

import { getServiceKey } from './lib/app-users-db.js';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const MAX_ROWS_PER_REQUEST = 500;
// Base64は元データの約1.33倍に膨らむ。Vercelのリクエストボディ上限(約4.5MB)を踏まえ、
// デコード後のファイルサイズで15MB相当(base64で約20MB)を上限とする。実際のメール添付は
// 通常これより十分小さいが、上限を明示しVBA側にも分かりやすいエラーを返せるようにする。
const MAX_DECODED_BYTES = 15 * 1024 * 1024;
const STORAGE_BUCKET = 'email-attachments';

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// storagePathとして許容する文字だけを通す(パストラバーサル・意図しないバケット外書き込みの防止)。
// VBA側はUrlEncodeを通さない生のファイル名+タイムスタンプ接頭辞をそのまま渡してくるため、
// ここでサーバー側でも最終防衛として検証する。
function isSafeStoragePath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 300 && /^[^\/\\]+$/.test(p) && !p.includes('..');
}

// メール本文のDB取込・重複チェック(旧api/email-import-insert.js)
async function handleInsert(req, res, serviceKey) {
  const body = req.body || {};

  // 重複チェック(VBA Module1_updated.basのIsDuplicateInQueue用)。従来anonキーで直接
  // Supabaseへ問い合わせていたが、他のVBA→Supabase書き込み経路と同様にx-import-key
  // 経由へ統一する(2026-08-21)。読み取り専用のSELECTだが、anonキーをVBAソースに
  // 残さないための対応。email_import_queueへの実際のINSERTはsubject+sender+received_at
  // のUNIQUE制約+resolution=ignore-duplicatesで最終的に二重防衛されているため、この
  // チェック自体は事前の早期リターン(不要なアップロード処理等を避ける)が主目的。
  if (body.action === 'checkDuplicate') {
    const { sender, receivedAt } = body;
    if (typeof sender !== 'string' || !sender) return res.status(400).json({ error: 'senderは必須です' });
    if (typeof receivedAt !== 'string' || !receivedAt) return res.status(400).json({ error: 'receivedAtは必須です' });
    try {
      const selRes = await fetch(
        `${SB_URL}/rest/v1/email_import_queue?select=id&sender=eq.${encodeURIComponent(sender)}&received_at=eq.${encodeURIComponent(receivedAt)}`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      );
      if (!selRes.ok) {
        const text = await selRes.text().catch(() => '');
        return res.status(502).json({ error: `重複チェックに失敗しました: ${selRes.status} ${text}` });
      }
      const rows = await selRes.json();
      return res.status(200).json({ ok: true, duplicate: Array.isArray(rows) && rows.length > 0 });
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  }

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

// 添付ファイルのSupabase Storageアップロード(旧api/email-attachment-upload.js)
async function handleAttachment(req, res, serviceKey) {
  const body = req.body || {};
  const { storagePath, contentBase64 } = body;
  if (!isSafeStoragePath(storagePath)) {
    return res.status(400).json({ error: 'storagePathが不正です（ファイル名のみ、パス区切り文字は使用不可）' });
  }
  if (typeof contentBase64 !== 'string' || !contentBase64) {
    return res.status(400).json({ error: 'contentBase64が空です' });
  }

  let bytes;
  try {
    bytes = Buffer.from(contentBase64, 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'contentBase64のデコードに失敗しました' });
  }
  if (bytes.length === 0) {
    return res.status(400).json({ error: 'デコード後のファイルサイズが0バイトです' });
  }
  if (bytes.length > MAX_DECODED_BYTES) {
    return res.status(413).json({ error: `ファイルサイズが上限(${Math.round(MAX_DECODED_BYTES / 1024 / 1024)}MB)を超えています（${Math.round(bytes.length / 1024 / 1024 * 10) / 10}MB）` });
  }

  try {
    const upRes = await fetch(
      `${SB_URL}/storage/v1/object/${STORAGE_BUCKET}/${encodeURIComponent(storagePath)}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/octet-stream',
        },
        body: bytes,
      }
    );
    if (!upRes.ok) {
      const text = await upRes.text().catch(() => '');
      return res.status(502).json({ error: `Storageへのアップロードに失敗しました: ${upRes.status} ${text}` });
    }
    const publicUrl = `${SB_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${encodeURIComponent(storagePath)}`;
    return res.status(200).json({ ok: true, publicUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
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

  // 旧URL(/api/email-import-insert, /api/email-attachment-upload)はvercel.jsonの
  // rewritesでlegacyModeクエリパラメータを付与してこのファイルへ転送される
  // (api/table-crud.jsのlegacyTableと同じ方式)。
  const legacyMode = req.query && req.query.legacyMode;
  if (legacyMode === 'insert') return handleInsert(req, res, serviceKey);
  if (legacyMode === 'attachment') return handleAttachment(req, res, serviceKey);
  return res.status(400).json({ error: `不明なlegacyModeです: ${legacyMode}` });
}
