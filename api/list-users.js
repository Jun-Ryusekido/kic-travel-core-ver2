import { appUsersFetch, getServiceKey } from './lib/app-users-db.js';
import { verifySessionToken } from './lib/session-token.js';

// アカウント管理ページ(管理者のみUI表示)向けのユーザー一覧取得API。
// password列は絶対に返さない(select指定で明示的に除外)。
//
// リクエストのtokenをverifySessionTokenで検証し、role==='admin'のログイン済み
// ユーザーのみ許可する(api/add-user.jsと同じ方式。2026-08-24追加。それまでは
// 「呼び出し元が本当に管理者か」の検証が無く、未ログインの第三者でもスタッフ全員の
// 氏名・メール・権限ロールを取得できてしまっていた)。
// POST化したのは、GETのクエリ文字列にtokenを乗せると同じ理由でログ等に残りやすい
// add-user.js側と挙動を揃えるため。
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const { token } = req.body || {};
  const session = verifySessionToken(token);
  if (!session) return res.status(401).json({ error: 'ログインセッションが無効です。再度ログインしてください。' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'アカウント管理は管理者のみ操作できます。' });

  try {
    const r = await appUsersFetch('?select=id,email,name,role,last_login,created_at&order=created_at');
    if (!r.ok) return res.status(500).json({ error: 'ユーザー一覧の取得に失敗しました' });
    const rows = await r.json();
    return res.status(200).json({ users: rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
