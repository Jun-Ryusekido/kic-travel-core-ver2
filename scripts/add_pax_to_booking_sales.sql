-- booking_sales に pax(人数)列を追加する。
-- 予約詳細の「売上明細」保存時にアプリがこの列へ書き込むが、
-- 列が存在しないためPostgRESTのスキーマキャッシュに乗らずエラーになっていた。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.booking_sales
  add column if not exists pax integer;

grant select, insert, update, delete on public.booking_sales to anon, authenticated, service_role;

notify pgrst, 'reload schema';
