-- bookings(予約本体)に国名を保持する列を追加する。
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.bookings add column if not exists country text;

notify pgrst, 'reload schema';
