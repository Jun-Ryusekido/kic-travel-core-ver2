-- bookings(予約本体)に種別(FIT/PKG等)を保持する列を追加する。
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.bookings add column if not exists booking_type text;

notify pgrst, 'reload schema';
