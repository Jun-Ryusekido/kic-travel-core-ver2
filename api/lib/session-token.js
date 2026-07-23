// ログイン成功時に発行し、その後の書き込み系サーバーレスAPI(/api/booking-sales等)への
// リクエストが正当なログインユーザーからのものかを検証するための、軽量な署名付きトークン。
//
// このアプリはSupabase Authを使わず、app_usersテーブルに対する独自ログイン(/api/login)の
// ため、Supabaseのセッション/JWTをそのまま流用することができない。かといって認証を全く
// 行わないままservice_role経由のAPIを公開するとRLSより危険な抜け道になってしまうため、
// サーバー側だけが知る秘密鍵でHMAC署名したトークンをログイン時に発行し、以後の書き込み
// リクエストではこの署名を検証してから処理する、という最小限の仕組みにしている。
//
// SESSION_TOKEN_SECRET環境変数が未設定の場合は、SUPABASE_SERVICE_ROLE_KEY自体を秘密鍵と
// して代用する(どちらもクライアントに渡らないサーバー専用の値のため、フォールバックとして
// 安全)。ただし本来は専用のSESSION_TOKEN_SECRETを設定するのが望ましい。
import crypto from 'crypto';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12時間（通常の勤務時間内であれば再ログイン不要な長さ）

function getSecret() {
  return process.env.SESSION_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

export function issueSessionToken(user) {
  const secret = getSecret();
  if (!secret) return null;
  const payload = { email: user.email, role: user.role, exp: Date.now() + TOKEN_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

// 検証に成功すればpayload({email, role, exp})を、失敗すればnullを返す。
export function verifySessionToken(token) {
  const secret = getSecret();
  if (!secret || !token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || !payload.exp || payload.exp < Date.now()) return null;
  return payload;
}
