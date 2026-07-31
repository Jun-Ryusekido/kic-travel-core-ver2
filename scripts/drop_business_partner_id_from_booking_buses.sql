-- 設計方針の誤りにより、booking_buses.business_partner_id(add_business_partner_id_to_booking_buses.sql
-- で追加)を使用しないこととした。バスのダブルブッキングチェックは「別予約間」ではなく
-- 「同一予約内での重複登録検知」に変更し、bus_companyの文字列一致のみで判定するため、
-- 取引先マスタへの参照列は不要になった。
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.booking_buses drop column if exists business_partner_id;

notify pgrst, 'reload schema';
