// ログイン/パスワード変更の総当たり対策(失敗回数によるロック)。
// DBスキーマ変更(SQL)を要さないよう、サーバー関数のメモリ上で数える方式にしている。
// Vercelでは同時に複数インスタンスが動き得るため完全な保証ではないが、1台に対する
// 連続試行は確実に止まる。より強い保証が必要になったらDB保持に移行すること。
const MAX_FAILS = 5;                 // この回数連続で失敗したらロック
const WINDOW_MS = 15 * 60 * 1000;    // 失敗を数える期間 / ロック時間
const MAX_KEYS = 5000;               // メモリ肥大防止

const fails = new Map(); // key -> { count, first }

function prune(now) {
  if (fails.size < MAX_KEYS) return;
  for (const [k, v] of fails) if (now - v.first > WINDOW_MS) fails.delete(k);
  if (fails.size >= MAX_KEYS) fails.clear();
}

export function throttleKey(req, email) {
  const ip = String((req.headers && (req.headers['x-forwarded-for'] || '')) || '').split(',')[0].trim();
  return `${String(email || '').toLowerCase()}|${ip}`;
}

// ロック中なら残り秒数を返し、ロックされていなければ0を返す。
export function lockedSeconds(key) {
  const now = Date.now();
  const v = fails.get(key);
  if (!v) return 0;
  if (now - v.first > WINDOW_MS) { fails.delete(key); return 0; }
  return v.count >= MAX_FAILS ? Math.ceil((WINDOW_MS - (now - v.first)) / 1000) : 0;
}

export function recordFailure(key) {
  const now = Date.now();
  prune(now);
  const v = fails.get(key);
  if (!v || now - v.first > WINDOW_MS) fails.set(key, { count: 1, first: now });
  else v.count += 1;
}

export function clearFailures(key) { fails.delete(key); }

export function lockedMessage(sec) {
  return `ログイン失敗が続いたため一時的にロックしました。約${Math.ceil(sec / 60)}分後にもう一度お試しください。`;
}
