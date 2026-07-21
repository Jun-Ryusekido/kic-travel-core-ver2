import { appUsersFetch, getServiceKey } from './lib/app-users-db.js';

// アカウント管理ページ(管理者のみUI表示)向けのユーザー一覧取得API。
// password列は絶対に返さない(select指定で明示的に除外)。
//
// 注意: このアプリはセッショントークンを持たない設計のため、現時点では
// 「呼び出し元が本当に管理者か」をサーバー側では検証できない(呼び出し自体は
// 誰でも叩けてしまう)。ただしpasswordを含む機微情報は返さないため、
// 従来anonキーで直接app_usersを丸ごとselectできていた状態(パスワード含む全件取得)
// に比べれば実質的な漏洩リスクは大幅に下がっている。将来的にセッション/トークン方式を
// 導入する際は、ここに管理者検証を追加すること。
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  try {
    const r = await appUsersFetch('?select=id,email,name,role,last_login,created_at&order=created_at');
    if (!r.ok) return res.status(500).json({ error: 'ユーザー一覧の取得に失敗しました' });
    const rows = await r.json();
    return res.status(200).json({ users: rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
