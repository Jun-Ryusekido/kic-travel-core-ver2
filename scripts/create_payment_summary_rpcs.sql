-- 入出金管理(booking_costs/booking_sales)を本格的なサーバー側集計方式に
-- 切り替えるためのRPC関数。
--
-- 背景: これまでの緊急修正(.range()ループによる全件取得)は動作はするが、
-- Access移行で100万件規模になると「1000件ずつ最大1000回」のリクエストが
-- 発生し非現実的になる。月別のSUM+GROUP BYと、期間・検索語によるサーバー側
-- 絞り込みをSupabase側のRPC関数で行い、必要な結果だけをブラウザに返す。
--
-- booking_sales.paymentsはJSONB配列(複数回入金に対応)のため、
-- jsonb_array_elementsで展開して集計する。配列が空/未設定の行は、
-- 旧形式のpayment_date/amount列にフォールバックする(index.htmlの
-- 既存クライアント側ロジックと同じ判定)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。
-- (前回提示済みのインデックス idx_booking_costs_payment_date /
--  idx_booking_costs_booking_id / idx_booking_sales_booking_id は
--  実行済みのため、本ファイルには含めない)

-- ===== 月別集計(入金合計・出金合計) =====
create or replace function get_payment_monthly_summary(p_from date, p_to date)
returns table(month text, total_in numeric, total_out numeric)
language sql stable
as $$
  with flows as (
    -- 入金: booking_sales.payments(JSONB配列)を展開
    select to_char((p->>'date')::date, 'YYYY-MM') as month,
           coalesce((p->>'amount')::numeric,0) as amount,
           'in' as flow
    from booking_sales s, jsonb_array_elements(coalesce(s.payments,'[]'::jsonb)) as p
    where (p->>'date') is not null and (p->>'date') <> ''
      and (p->>'date')::date between p_from and p_to
    union all
    -- 入金: payments未設定の行は旧形式payment_date/amountにフォールバック
    select to_char(s.payment_date,'YYYY-MM'), coalesce(s.amount,0), 'in'
    from booking_sales s
    where (s.payments is null or jsonb_array_length(s.payments)=0)
      and s.payment_date is not null
      and s.payment_date between p_from and p_to
    union all
    -- 出金: booking_costs
    select to_char(c.payment_date,'YYYY-MM'), coalesce(c.amount,0), 'out'
    from booking_costs c
    where c.payment_date is not null
      and c.payment_date between p_from and p_to
  )
  select month,
    sum(amount) filter (where flow='in')  as total_in,
    sum(amount) filter (where flow='out') as total_out
  from flows
  group by month
  order by month;
$$;

grant execute on function get_payment_monthly_summary(date, date) to anon, authenticated, service_role;

-- ===== 入金明細(期間・検索語で絞り込み) =====
create or replace function search_payment_income(p_from date, p_to date, p_search text default null)
returns table(
  payment_date date,
  amount numeric,
  item_name text,
  bank text,
  ref_no text,
  agent_name text,
  tour_name text
)
language sql stable
as $$
  -- src_idはページング(.range())の境界を跨いでも順序が安定するよう、
  -- payment_dateの同値(タイ)を一意に決着させるための内部専用の並び替えキー。
  -- 最終的な返り値の列には含めない(RETURNS TABLEの列数・順序と一致させるため)。
  with unioned as (
    select (p->>'date')::date as payment_date,
      coalesce((p->>'amount')::numeric,0) as amount,
      coalesce(s.item_name,'') as item_name,
      coalesce(p->>'bank','') as bank,
      b.ref_no as ref_no, b.agent_name as agent_name, b.tour_name as tour_name,
      s.id as src_id, (p->>'date') as src_tiebreak
    from booking_sales s
    join lateral jsonb_array_elements(coalesce(s.payments,'[]'::jsonb)) as p on true
    left join bookings b on b.id = s.booking_id
    where (p->>'date') is not null and (p->>'date') <> ''
      and (p->>'date')::date between p_from and p_to
      and (
        p_search is null or p_search = '' or
        concat_ws(' ', b.ref_no, b.agent_name, s.item_name) ilike '%'||p_search||'%'
      )
    union all
    select s.payment_date as payment_date,
      coalesce(s.amount,0) as amount,
      coalesce(s.item_name,'') as item_name,
      '' as bank,
      b.ref_no as ref_no, b.agent_name as agent_name, b.tour_name as tour_name,
      s.id as src_id, null as src_tiebreak
    from booking_sales s
    left join bookings b on b.id = s.booking_id
    where (s.payments is null or jsonb_array_length(s.payments)=0)
      and s.payment_date is not null
      and s.payment_date between p_from and p_to
      and (
        p_search is null or p_search = '' or
        concat_ws(' ', b.ref_no, b.agent_name, s.item_name) ilike '%'||p_search||'%'
      )
  )
  select payment_date, amount, item_name, bank, ref_no, agent_name, tour_name
  from unioned
  order by payment_date desc, src_id, src_tiebreak;
$$;

grant execute on function search_payment_income(date, date, text) to anon, authenticated, service_role;

-- ===== 出金明細(期間・検索語で絞り込み) =====
create or replace function search_payment_outflow(p_from date, p_to date, p_search text default null)
returns table(
  payment_date date,
  amount numeric,
  item_name text,
  memo text,
  ref_no text,
  agent_name text,
  tour_name text
)
language sql stable
as $$
  select c.payment_date, coalesce(c.amount,0), coalesce(c.item_name,''), coalesce(c.memo,''),
    b.ref_no, b.agent_name, b.tour_name
  from booking_costs c
  left join bookings b on b.id = c.booking_id
  where c.payment_date is not null
    and c.payment_date between p_from and p_to
    and (
      p_search is null or p_search = '' or
      concat_ws(' ', b.ref_no, b.agent_name, c.item_name, c.memo) ilike '%'||p_search||'%'
    )
  -- c.idはページング(.range())の境界を跨いでも順序が安定するよう、
  -- payment_dateの同値(タイ)を一意に決着させるための内部専用の並び替えキー。
  order by c.payment_date desc, c.id;
$$;

grant execute on function search_payment_outflow(date, date, text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
