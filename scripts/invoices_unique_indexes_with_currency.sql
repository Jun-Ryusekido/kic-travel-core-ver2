-- invoicesの同一判定キーに通貨(currency)を含めるための一意インデックス整備(2026-09、RLS対応バッチ1の前提)。
--
-- 業務判断(JUN): 同じ予約・同じ請求先で、JPYとUSDの請求書を両方残すことがある。
--   個別Invoice: booking_id + is_consolidated=false + agent_name + currency
--   合算Invoice: booking_id + is_consolidated=true  + currency
--     (generateInvoiceは発行のたびに同じ通貨でupsertConsolidatedInvoiceを呼び、「USD合算発行」
--      ボタンもあるため、合算Invoiceも通貨別に発行されうる)
--
-- 内容:
--   1. currencyのNOT NULL化(default 'JPY'は維持。2026-09時点でNULLの行は0件)
--   2. 合算: 旧 invoices_one_consolidated_per_booking (booking_id) WHERE is_consolidated を
--      (booking_id, currency) WHERE is_consolidated に作り替え(旧インデックスはdrop)
--   3. 個別: (booking_id, agent_name, currency) NULLS NOT DISTINCT WHERE NOT is_consolidated を新設
--      (agent_nameがNULLの行同士も重複として扱う。PostgreSQL 15以上が必要、本番は17.6)
--
-- 現行コード(通貨をキーに含まない既存行検索)のままでもこの変更で既存の発行・再発行は
-- 失敗しない(根拠は同じコミットの報告参照): 個別・合算とも「既存行があればUPDATE、無ければ
-- INSERT」で、同じ(booking_id, agent_name)/(booking_id)に2行目を作らないため、新インデックスの
-- どちらにも違反しない。currencyはすべての書き込み経路で'JPY'/'USD'が必ず送られる。
--
-- Supabaseダッシュボードの SQL Editor で、上から順に実行すること。
-- 【実行前確認】→【本体(1トランザクション)】→【実行後確認】の3段。

-- ============================================================
-- 【実行前確認】(読み取り専用)
-- ============================================================
-- (1) 既存インデックス一覧。同名・同等のインデックスが既にあれば本体の該当createは不要
--     (本体は同名ならIF NOT EXISTSでスキップする)。
select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'invoices'
order by indexname;

-- (2) currency列の型・NULL許容・既定値(期待: text / YES / 'JPY'::text)
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'invoices' and column_name = 'currency';

-- (3) 新キーでの重複・currency NULLが0件であること(期待: すべて0)
select
  (select count(*) from public.invoices where currency is null) as currency_null,
  (select count(*) from (select 1 from public.invoices where not is_consolidated
                         group by booking_id, agent_name, currency having count(*) > 1) x) as individual_dup_groups,
  (select count(*) from (select 1 from public.invoices where is_consolidated
                         group by booking_id, currency having count(*) > 1) y) as consolidated_dup_groups;

-- ============================================================
-- 【本体】1トランザクションで実行。事前条件を満たさない場合は例外で全体を取り消す。
-- ============================================================
begin;

do $$
declare
  v_null int; v_ind int; v_con int;
begin
  select count(*) into v_null from public.invoices where currency is null;
  select count(*) into v_ind from (select 1 from public.invoices where not is_consolidated
                                   group by booking_id, agent_name, currency having count(*) > 1) x;
  select count(*) into v_con from (select 1 from public.invoices where is_consolidated
                                   group by booking_id, currency having count(*) > 1) y;
  if v_null > 0 or v_ind > 0 or v_con > 0 then
    raise exception '事前条件エラー: currency NULL=%件, 個別重複=%グループ, 合算重複=%グループ。何も変更せず中止します', v_null, v_ind, v_con;
  end if;
end $$;

alter table public.invoices alter column currency set not null;

drop index if exists public.invoices_one_consolidated_per_booking;

create unique index if not exists invoices_one_consolidated_per_booking_currency
  on public.invoices (booking_id, currency)
  where is_consolidated;

create unique index if not exists invoices_one_individual_per_booking_agent_currency
  on public.invoices (booking_id, agent_name, currency) nulls not distinct
  where not is_consolidated;

commit;

notify pgrst, 'reload schema';

-- ============================================================
-- 【実行後確認】(読み取り専用)
-- ============================================================
-- 期待: invoices_one_consolidated_per_booking が無く、
--       invoices_one_consolidated_per_booking_currency / invoices_one_individual_per_booking_agent_currency がある
select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'invoices'
order by indexname;

-- 期待: is_nullable = NO、column_default = 'JPY'::text
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'invoices' and column_name = 'currency';

-- 【切り戻し】(問題があった場合のみ。通常は実行しない)
-- begin;
-- drop index if exists public.invoices_one_individual_per_booking_agent_currency;
-- drop index if exists public.invoices_one_consolidated_per_booking_currency;
-- create unique index if not exists invoices_one_consolidated_per_booking on public.invoices(booking_id) where is_consolidated;
-- alter table public.invoices alter column currency drop not null;
-- commit;
-- notify pgrst, 'reload schema';
