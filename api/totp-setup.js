import QRCode from 'qrcode';
import { OTP } from 'otplib';
import { appUsersFetch, getServiceKey } from './lib/app-users-db.js';
import { verifySessionToken } from './lib/session-token.js';

// admin@kictravel.jp用の2段階認証(TOTP)初期設定API。
//
// admin@kictravel.jpは実メールアドレスが無く、JUNさんと他1名の2名で共有利用している
// アカウントのため、誰がログインしたかの個別区別は行わず、TOTPシークレットも1つだけ
// 生成してQRコードで2人に共有してもらう運用とする。
//
// このアカウント以外(jr@/joshua@/yoshida@/kanri@/bando@)には今回のTOTP機能は一切
// 影響しない(このAPI自体、対象をadmin@kictravel.jpに固定している)。
//
// 呼び出しにはログイン済みセッションのtoken(/api/loginが発行)が必須で、かつその
// セッションのemailがadmin@kictravel.jp自身であることを要求する(admin@でログイン
// 済みの状態からしかQR/シークレットを閲覧できない)。既にtotp_secretが設定済みの
// 場合は新規生成せず、既存の値からQRを再生成して返す(再スキャン・追加共有用)。
const TOTP_ACCOUNT_EMAIL = 'admin@kictravel.jp';
const ISSUER = 'KIC Travel Core';
const totpGen = new OTP({ strategy: 'totp' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!getServiceKey()) return res.status(500).json({ error: 'サーバー側にSUPABASE_SERVICE_ROLE_KEYが設定されていません' });

  const { token } = req.body || {};
  const session = verifySessionToken(token);
  if (!session) return res.status(401).json({ error: 'ログインセッションが無効です。再度ログインしてください。' });
  if (session.email !== TOTP_ACCOUNT_EMAIL) {
    return res.status(403).json({ error: '2段階認証の設定はadmin@kictravel.jpでログインした状態でのみ行えます。' });
  }

  try {
    const r = await appUsersFetch(`?email=eq.${encodeURIComponent(TOTP_ACCOUNT_EMAIL)}&select=id,totp_secret`);
    if (!r.ok) return res.status(500).json({ error: 'ユーザー情報の取得に失敗しました' });
    const rows = await r.json();
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'admin@kictravel.jpアカウントが見つかりません' });

    let secret = user.totp_secret;
    if (!secret) {
      secret = totpGen.generateSecret();
      const upd = await appUsersFetch(`?id=eq.${user.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ totp_secret: secret }),
      });
      if (!upd.ok) return res.status(500).json({ error: 'シークレットの保存に失敗しました' });
    }

    const otpauthUri = totpGen.generateURI({ issuer: ISSUER, label: TOTP_ACCOUNT_EMAIL, secret });
    const qrDataUrl = await QRCode.toDataURL(otpauthUri);
    return res.status(200).json({ secret, otpauthUri, qrDataUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
