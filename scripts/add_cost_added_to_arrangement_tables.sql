-- 手配タブ(ホテル・バス・レストラン・観光施設・ミネラルウォーター)各行に追加した
-- 「仕入に追加」チェックボックスの反映済みフラグ(cost_added)を保存するための列追加。
--
-- 一度チェックを入れて保存し仕入明細(booking_costs)へ反映した行は、このフラグをtrueにして
-- 再保存時に二重で仕入明細へ追加されないようにする(index.htmlのmergeArrCostCheckedRows参照)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.booking_hotels add column if not exists cost_added boolean not null default false;
alter table public.booking_buses add column if not exists cost_added boolean not null default false;
alter table public.booking_restaurants add column if not exists cost_added boolean not null default false;
alter table public.booking_facilities add column if not exists cost_added boolean not null default false;
alter table public.booking_water_items add column if not exists cost_added boolean not null default false;

notify pgrst, 'reload schema';
