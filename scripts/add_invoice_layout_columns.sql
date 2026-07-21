-- Invoice画面を旧Access版フォーマットに合わせて作り直すための追加カラム。
-- Supabaseダッシュボードの SQL Editor で実行すること。

-- invoices: 新レイアウトのName/Group・Itinerary・Note・Person in Chargeの保存先。
-- (Attn/Tour Code/Remarksの自由入力欄は本レイアウトでは廃止し、この4項目に置き換える)
alter table public.invoices
  add column if not exists name_group text default '',
  add column if not exists itinerary text default '',
  add column if not exists note text default '',
  add column if not exists person_in_charge text default '';

-- booking_sales: 明細行に「単価・人数・数量」を横並びで表示するため、
-- 既存のqty(数量)とは別に人数(pax)を持たせる。既存行はデフォルト1で埋める。
alter table public.booking_sales
  add column if not exists pax integer not null default 1;

grant select, insert, update, delete on public.invoices to anon, authenticated, service_role;
grant select, insert, update, delete on public.booking_sales to anon, authenticated, service_role;

notify pgrst, 'reload schema';
