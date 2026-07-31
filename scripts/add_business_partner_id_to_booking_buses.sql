-- booking_buses(バス明細)に、business_partners(取引先マスタ)への参照列を追加する。
-- 目的: bus_companyは現状テキストのみで取引先マスタと紐づいていないため、会社単位での
-- ダブルブッキング(重複依頼)チェック(checkBusDoubleBookings)ができるようにする。
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.booking_buses
  add column if not exists business_partner_id uuid references public.business_partners(id) on delete set null;

create index if not exists booking_buses_business_partner_id_idx on public.booking_buses(business_partner_id);

notify pgrst, 'reload schema';
