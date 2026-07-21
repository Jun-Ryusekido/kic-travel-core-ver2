-- 手配管理の各タブ(ホテル・バス・ミネラルウォーター・新幹線・ガイド)に
-- payment_method(支払方法)列を追加する。
--
-- レストラン(booking_restaurants)・観光施設(booking_facilities)には既に
-- payment_method列があるため対象外。今回追加するのは以下5テーブルのみ:
--   booking_hotels, booking_buses, booking_water_items,
--   bullet_train_arrangements, booking_guides
--
-- 「現地払い」のものだけが実際に現金の仮払いが必要な対象であり、
-- 「後請求」「全旅クーポン」「前振込み」は今回のツアー中の現金仮払いは不要、
-- という判定を仮払い一覧表側で行うための入力欄。既存データは列追加時点では
-- 全てNULL(未設定)になるが、アプリ側は payment_method||'' で空文字として
-- 扱うため、既存の予約データの表示・保存には影響しない。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.booking_hotels
  add column if not exists payment_method text;
alter table public.booking_buses
  add column if not exists payment_method text;
alter table public.booking_water_items
  add column if not exists payment_method text;
alter table public.bullet_train_arrangements
  add column if not exists payment_method text;
alter table public.booking_guides
  add column if not exists payment_method text;

grant select, insert, update, delete on public.booking_hotels to anon, authenticated, service_role;
grant select, insert, update, delete on public.booking_buses to anon, authenticated, service_role;
grant select, insert, update, delete on public.booking_water_items to anon, authenticated, service_role;
grant select, insert, update, delete on public.bullet_train_arrangements to anon, authenticated, service_role;
grant select, insert, update, delete on public.booking_guides to anon, authenticated, service_role;

notify pgrst, 'reload schema';
