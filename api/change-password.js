import bcrypt from 'bcryptjs';
import { appUsersFetch, getServiceKey, looksLikeBcryptHash } from './lib/app-users-db.js';
import { verifySessionToken } from './lib/session-token.js';
import { throttleKey, lockedSeconds, recordFailure, clearFailures, lockedMessage } from './lib/login-throttle.js';

// パスワード変更API。現在のパスワードの照合をサーバー側で必須にすることで、
// (anonキー経由でapp_usersを直接updateできた従来方式と異なり)userIdさえ分かれば
// 他人のパスワードを書き換えられる、という状態を防ぐ。
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const { userId, oldPassword, newPassword, token } = req.body || {};
  // ログイン済みセッションの検証(従来はuserIdと現在のパスワードだけで変更できた)
  const session = verifySessionToken(token);
  if (!session) return res.status(401).json({ error: 'ログインセッションが無効です。再度ログインしてください。' });
  if (!userId || !oldPassword || !newPassword) return res.status(400).json({ error: '現在のパスワードと新しいパスワードを入力してください' });
  if (newPassword.length < 8) return res.status(400).json({ error: '新しいパスワードは8文字以上で入力してください' });

  const tkey = throttleKey(req, 'cp:' + session.email);
  const locked = lockedSeconds(tkey);
  if (locked) return res.status(429).json({ error: lockedMessage(locked) });

  try {
    const r = await appUsersFetch(`?id=eq.${encodeURIComponent(userId)}&select=*`);
    if (!r.ok) return res.status(500).json({ error: 'ユーザー情報の取得に失敗しました' });
    const rows = await r.json();
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });

    // 他人のパスワードは、セッションが別ユーザーのものである限り変更不可
    if (user.email !== session.email) return res.status(403).json({ error: '自分のパスワードのみ変更できます。' });

    const stored = user.password || '';
    const ok = looksLikeBcryptHash(stored) ? await bcrypt.compare(oldPassword, stored) : oldPassword === stored;
    if (!ok) { recordFailure(tkey); return res.status(401).json({ error: '現在のパスワードが違います' }); }
    clearFailures(tkey);

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
