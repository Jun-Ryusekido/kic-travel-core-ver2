import bcrypt from 'bcryptjs';
import { appUsersFetch, getServiceKey } from './lib/app-users-db.js';

// アカウント管理ページ(管理者のみUI表示)向けの新規ユーザー追加API。
// パスワードはここでbcryptハッシュ化してから保存するため、新規ユーザーは
// 最初から平文保存にならない。
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || password.length < 8) {
    return res.status(400).json({ error: '氏名・Email・パスワード(8文字以上)を入力してください' });
  }
  if (!['admin', 'staff', 'view'].includes(role)) {
    return res.status(400).json({ error: '権限の指定が不正です' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await appUsersFetch('', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({ name, email, password: hash, role }),
    });
    if (!r.ok) {
      const detail = await r.text();
      return res.status(500).json({ error: '追加に失敗しました: ' + detail });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
