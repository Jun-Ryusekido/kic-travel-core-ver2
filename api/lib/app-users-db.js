// app_users専用の内部ヘルパー。anonキーからapp_usersへの直接アクセスを遮断した後、
// ログイン/パスワード変更/ユーザー管理はこのモジュール経由(service_role key)でのみ行う。
// SUPABASE_SERVICE_ROLE_KEYはVercelの環境変数で設定すること(anonキーと違いRLS/GRANTを
// バイパスするため、絶対にクライアント側コードに含めない)。

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';

export function getServiceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

export async function appUsersFetch(path, opts = {}) {
  const serviceKey = getServiceKey();
  const res = await fetch(`${SB_URL}/rest/v1/app_users${path}`, {
    ...opts,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  return res;
}

// パスワード列がbcryptハッシュ(先頭 $2a$/$2b$/$2y$)かどうかの判定。
// 移行前の既存ユーザーは平文で保存されているため、この判定で新旧2方式を出し分ける。
export function looksLikeBcryptHash(value) {
  return /^\$2[aby]\$/.test(String(value || ''));
}
