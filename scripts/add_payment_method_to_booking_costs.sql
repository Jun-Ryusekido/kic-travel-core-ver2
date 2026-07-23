-- 仕入明細(booking_costs)に「支払方法」列を追加する。
-- 既存の手配タブ(ホテル・バス等)や仮払い一覧表と同じ語彙(現地払い/事前決済/請求書払い/
-- 全旅クーポン/無料(FREE))を使う想定のため、型はtextとし特にCHECK制約は設けない
-- (アプリ側のセレクトボックスで選択肢を統一する)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.booking_costs add column if not exists payment_method text;

notify pgrst, 'reload schema';
