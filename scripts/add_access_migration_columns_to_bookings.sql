-- bookings(予約本体)に、Access移行対応の列を追加する。
-- country/booking_typeは既に追加済みの場合もあるが、if not existsのため再実行しても安全。
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.bookings add column if not exists country text;
alter table public.bookings add column if not exists booking_type text;
alter table public.bookings add column if not exists memo1 text;
alter table public.bookings add column if not exists memo2 text;
alter table public.bookings add column if not exists memo3 text;

notify pgrst, 'reload schema';
