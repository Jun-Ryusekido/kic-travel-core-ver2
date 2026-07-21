import bcrypt from 'bcryptjs';
import { appUsersFetch, getServiceKey, looksLikeBcryptHash } from './lib/app-users-db.js';

// パスワード変更API。現在のパスワードの照合をサーバー側で必須にすることで、
// (anonキー経由でapp_usersを直接updateできた従来方式と異なり)userIdさえ分かれば
// 他人のパスワードを書き換えられる、という状態を防ぐ。
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const { userId, oldPassword, newPassword } = req.body || {};
  if (!userId || !oldPassword || !newPassword) return res.status(400).json({ error: '現在のパスワードと新しいパスワードを入力してください' });
  if (newPassword.length < 8) return res.status(400).json({ error: '新しいパスワードは8文字以上で入力してください' });

  try {
    const r = await appUsersFetch(`?id=eq.${encodeURIComponent(userId)}&select=*`);
    if (!r.ok) return res.status(500).json({ error: 'ユーザー情報の取得に失敗しました' });
    const rows = await r.json();
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });

    const stored = user.password || '';
    const ok = looksLikeBcryptHash(stored) ? await bcrypt.compare(oldPassword, stored) : oldPassword === stored;
    if (!ok) return res.status(401).json({ error: '現在のパスワードが違います' });

    const newHash = await bcrypt.hash(newPassword, 10);
    const upd = await appUsersFetch(`?id=eq.${user.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ password: newHash }),
    });
    if (!upd.ok) return res.status(500).json({ error: 'パスワードの更新に失敗しました' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
