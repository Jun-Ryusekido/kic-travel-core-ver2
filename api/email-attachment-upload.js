// Outlookからのメール取り込み(email-automation/exports/2026-08-14/Module1_updated.bas、
// SendMailItemToKICQueue経由の添付ファイルアップロード)専用の書き込みエンドポイント。
//
// これまでUploadFileToStorage(VBA)がSupabase Storage(email-attachmentsバケット)へ
// anonキーで直接バイナリPOSTしていた。/api/email-import-insert.jsと同じ理由
// (Windowsタスクスケジューラ/手動マクロからの無人・非セッション実行のため、
// table-crud.jsのセッショントークン認証は使えない)で、同じ共有シークレット
// (x-import-keyヘッダー)方式のservice_role backedエンドポイントに切り替える。
//
// EMAIL_IMPORT_API_KEY・SUPABASE_SERVICE_ROLE_KEYは/api/email-import-insert.jsと
// 共通のVercel環境変数(既に設定済み)をそのまま使う。新しいキーの追加は不要。

import { getServiceKey } from './lib/app-users-db.js';

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const STORAGE_BUCKET = 'email-attachments';
// Base64は元データの約1.33倍に膨らむ。Vercelのリクエストボディ上限(約4.5MB)を踏まえ、
// デコード後のファイルサイズで15MB相当(base64で約20MB)を上限とする。実際のメール添付は
// 通常これより十分小さいが、上限を明示しVBA側にも分かりやすいエラーを返せるようにする。
const MAX_DECODED_BYTES = 15 * 1024 * 1024;

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
