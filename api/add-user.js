import bcrypt from 'bcryptjs';
import { appUsersFetch, getServiceKey } from './lib/app-users-db.js';
import { verifySessionToken } from './lib/session-token.js';

// アカウント管理ページ(管理者のみUI表示)向けのユーザー管理API。
// Vercel Hobbyプランの関数数上限(12本)のため、新規関数は作らずmodeパラメータで拡張する:
//   mode省略 or 'add' : 新規ユーザー追加(従来互換)
//   mode 'delete'     : ユーザー削除
//   mode 'resetPassword' : パスワード強制リセット(bcryptハッシュ化して保存)
//   mode 'changeRole' : 権限(admin/staff/view)変更
//
// すべての操作で、リクエストのtokenをverifySessionTokenで検証し、
// role==='admin'のログイン済みユーザーのみ許可する(2026-08-12追加。
// それまでは「呼び出し元が本当に管理者か」の検証が無かった)。
// パスワードはbcryptハッシュ化してから保存するため平文保存にならない。
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const { token, mode } = req.body || {};
  const session = verifySessionToken(token);
  if (!session) return res.status(401).json({ error: 'ログインセッションが無効です。再度ログインしてください。' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'アカウント管理は管理者のみ操作できます。' });

  try {
    if (!mode || mode === 'add') {
      const { name, email, password, role } = req.body || {};
      if (!name || !email || !password || password.length < 8) {
        return res.status(400).json({ error: '氏名・Email・パスワード(8文字以上)を入力してください' });
      }
      if (!['admin', 'staff', 'view'].includes(role)) {
        return res.status(400).json({ error: '権限の指定が不正です' });
      }
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
    }

    if (mode === 'delete') {
      const { userId } = req.body || {};
      if (!userId) return res.status(400).json({ error: '削除対象が指定されていません' });
      // 自分自身の削除は禁止(誤操作で管理者が誰もいなくなる事故を防ぐ)。
      // userIdからemailを取得して、セッションのemailと比較する。
      const cur = await appUsersFetch(`?id=eq.${encodeURIComponent(userId)}&select=email`);
      if (!cur.ok) return res.status(500).json({ error: '対象ユーザーの確認に失敗しました' });
      const rows = await cur.json();
      if (!rows.length) return res.status(404).json({ error: '対象ユーザーが見つかりません' });
      if (rows[0].email === session.email) {
        return res.status(400).json({ error: '自分自身のアカウントは削除できません。' });
      }
      const r = await appUsersFetch(`?id=eq.${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      });
      if (!r.ok) {
        const detail = await r.text();
        return res.status(500).json({ error: '削除に失敗しました: ' + detail });
      }
      return res.status(200).json({ ok: true });
    }

    if (mode === 'resetPassword') {
      const { userId, newPassword } = req.body || {};
      if (!userId || !newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: '対象ユーザーと新パスワード(8文字以上)を指定してください' });
      }
      const hash = await bcrypt.hash(newPassword, 10);
      const r = await appUsersFetch(`?id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ password: hash }),
      });
      if (!r.ok) {
        const detail = await r.text();
        return res.status(500).json({ error: 'パスワードのリセットに失敗しました: ' + detail });
      }
      return res.status(200).json({ ok: true });
    }

    if (mode === 'changeRole') {
      const { userId, role } = req.body || {};
      if (!userId || !['admin', 'staff', 'view'].includes(role)) {
        return res.status(400).json({ error: '対象ユーザーと権限(admin/staff/view)を正しく指定してください' });
      }
      // 自分自身をadmin以外に降格することは禁止(誤操作で管理者が誰もいなくなる事故を防ぐ)。
      const cur = await appUsersFetch(`?id=eq.${encodeURIComponent(userId)}&select=email`);
      if (!cur.ok) return res.status(500).json({ error: '対象ユーザーの確認に失敗しました' });
      const rows = await cur.json();
      if (!rows.length) return res.status(404).json({ error: '対象ユーザーが見つかりません' });
      if (rows[0].email === session.email && role !== 'admin') {
        return res.status(400).json({ error: '自分自身の権限を管理者以外に変更することはできません。' });
      }
      const r = await appUsersFetch(`?id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ role }),
      });
      if (!r.ok) {
        const detail = await r.text();
        return res.status(500).json({ error: '権限の変更に失敗しました: ' + detail });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `不明なmodeです: ${mode}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
