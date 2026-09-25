// lib/session-token.js の verifySessionToken と同じ検証を、Edgeランタイム(Nodeのcryptoモジュールが
// 使えない)向けにWeb Crypto(crypto.subtle)で行う版。トークンの形式・秘密鍵・有効期限の判定は
// session-token.js と完全に同じ(発行はNode側のissueSessionTokenのみ)。
// 対象: api/partner-similarity.js / api/ai-inbox.js(有料のAI呼び出しの前にログインを確認する。2026-09-25 JUN決定)。

function getSecret() {
  return process.env.SESSION_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function bytesToBase64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 長さが同じなら全文字を比較する(一致しない位置で早く抜けない)。
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 検証に成功すればpayload({email, role, exp})を、失敗すればnullを返す。
export async function verifySessionTokenEdge(token) {
  const secret = getSecret();
  if (!secret || !token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
    if (!constantTimeEqual(sig, bytesToBase64url(new Uint8Array(mac)))) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64)));
    if (!payload || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// 認証に失敗した時の応答(401)。extract-card と同じ文言・code。
export function sessionRequiredResponse() {
  return new Response(JSON.stringify({
    error: 'ログインを確認できませんでした。画面を再読み込みしてから、もう一度お試しください(続く場合は再ログインしてください)。',
    code: 'SESSION_REQUIRED',
  }), { status: 401, headers: { 'Content-Type': 'application/json' } });
}
