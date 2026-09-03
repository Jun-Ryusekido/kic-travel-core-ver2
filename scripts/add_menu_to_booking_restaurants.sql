-- レストランタブ(booking_restaurants)に、料理内容を自由入力できる「Menu」列を追加する。
--
-- 既存カラムに流用できるものが無いため(memoは「備考」欄として既に使用中)、
-- 新規カラムmenu(text)を追加する。書き込みは既にservice_role経由に一本化済み
-- (scripts/lock_down_booking_hotels_buses_restaurants_facilities_writes.sql実行済み)
-- のため、GRANT/REVOKEの変更は不要でALTER TABLEのみで完結する。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.booking_restaurants
  add column if not exists menu text;

notify pgrst, 'reload schema';
