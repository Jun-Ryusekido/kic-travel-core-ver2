-- 毎時バックアップの差分化のため、booking_costs(仕入明細)にupdated_at列を追加する。
-- booking_costsへの書き込みは全てtable-crud.js(service_role専用API)経由であることを
-- 確認済み(sb.from('booking_costs')による直接anon書き込みは0件)。
-- api/table-crud.jsのTABLE_CONFIG.booking_costsにstampUpdatedAt:trueを設定し、
-- insert/replace時にサーバー側で確実にこの列をスタンプする(既存のbooking_buses/
-- booking_restaurantsと同じ方式)。
alter table public.booking_costs
  add column if not exists updated_at timestamptz not null default now();

grant select, insert, update, delete on public.booking_costs to anon, authenticated, service_role;

notify pgrst, 'reload schema';
