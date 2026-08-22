import bcrypt from 'bcryptjs';
import { OTP } from 'otplib';
import { appUsersFetch, getServiceKey, looksLikeBcryptHash } from './lib/app-users-db.js';
import { issueSessionToken } from './lib/session-token.js';

// ログイン専用API。anonキーからapp_usersへの直接select/update権限を廃止したため、
// ログイン時の照合とlast_login更新はすべてこのサーバー側関数(service_role key)で行う。
//
// 既存ユーザーは平文パスワードのまま保存されているため、移行を簡単にするために
// 「ログイン成功のタイミングで自動的にbcryptハッシュへ置き換える」方式にしている
// (一括移行スクリプトを実行する必要がない)。
//
// app_users.totp_secretが設定されているユーザー(現状はadmin@kictravel.jpのみ、
// /api/totp-setupで生成)は、パスワード照合に加えて6桁のTOTPコード照合が必要。
// totpCode未送信 or 空の場合は{totpRequired:true}を返し、クライアント側で
// コード入力画面に切り替えさせる(パスワード自体は合っているため、通常の
// 「IDまたはパスワードが違います」エラーとは区別する)。
const totpVerifier = new OTP({ strategy: 'totp' });
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const { email, password, totpCode } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'メールアドレスとパスワードを入力してください' });

  try {
    const r = await appUsersFetch(`?email=eq.${encodeURIComponent(email)}&select=*`);
    if (!r.ok) return res.status(500).json({ error: 'ユーザー情報の取得に失敗しました' });
    const rows = await r.json();
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'メールアドレスまたはパスワードが違います' });

    const stored = user.password || '';
    let ok;
    if (looksLikeBcryptHash(stored)) {
      ok = await bcrypt.compare(password, stored);
    } else {
      // 平文保存の既存ユーザー。一致すればログインを許可し、この場を借りてbcryptハッシュに
      // 置き換える(次回以降はbcrypt比較に切り替わる＝自動移行)。
      ok = password === stored;
      if (ok) {
        const newHash = await bcrypt.hash(password, 10);
        await appUsersFetch(`?id=eq.${user.id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ password: newHash }),
        });
      }
    }
    if (!ok) return res.status(401).json({ error: 'メールアドレスまたはパスワードが違います' });

    if (user.totp_secret) {
      const code = String(totpCode || '').trim();
      if (!code) return res.status(200).json({ totpRequired: true });
      const result = await totpVerifier.verify({ secret: user.totp_secret, token: code, epochTolerance: 30 });
      if (!result.valid) return res.status(401).json({ error: '認証コードが正しくありません', totpRequired: true });
    }

    const nowIso = new Date().toISOString();
    await appUsersFetch(`?id=eq.${user.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ last_login: nowIso }),
    });

    const { password: _pw, totp_secret: _totp, ...safeUser } = user;
    safeUser.last_login = nowIso;
    // service_role経由の書き込みAPI(/api/booking-sales等)向けに、署名付きセッション
    // トークンを発行する。currentUserとして丸ごとlocalStorageに保存されるため、
    // 以後このトークンをリクエストに添えるだけで済む。
    safeUser.token = issueSessionToken(safeUser);
    return res.status(200).json({ user: safeUser });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
