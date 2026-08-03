-- GROSS/粗利管理画面の拡張: 四半期集計・前年同期比・Top-Nツアー抽出。
--
-- 背景: get_gross_summary()は決算年度の月別集計のみを返す。今回、複数ツアーを横断した
-- 収益性レポーティングの第一段として、(1)四半期単位のサマリー、(2)前年度の同月と並べて
-- 比較できる形の月次データ、(3)粗利額/粗利率の上位・下位N件抽出、をサーバー側RPCで
-- 追加する。get_gross_summary()自体は既存画面が引き続き参照しているため変更しない
-- (新規RPCとして追加し、既存の月別集計に影響を与えない)。
--
-- get_gross_summary()と同じ理由(bookingsが10万件規模)により、集計はbookingsテーブル単体の
-- 非正規化キャッシュ列(gross_sales/gross_cost)に対するSUM+GROUP BYのみで完結させ、
-- booking_sales/booking_costsのJOIN・JSONB展開は行わない。
--
-- 決算年度の定義は既存のfiscalYearOf()/fiscalYearRange()(index.html)と同じく
-- 「fy年3月〜fy+1年2月」。四半期はfiscalYearMonths(fy)の並び(3月始まり12ヶ月)を
-- 3ヶ月ずつ区切ったもの: Q1=3-5月, Q2=6-8月, Q3=9-11月, Q4=12-2月。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

-- ── get_gross_trends: 指定決算年度と前年度、両方の月別・四半期別集計を1本で返す ──
-- クライアント側(loadGrossTrends()等)で fiscal_year・period_type によって
-- 当年/前年・月別/四半期別に振り分けて表示する。対象データが1件も無い
-- 決算年度(当年・前年とも)はエラーにならず、単に該当行が0件で返る。
create or replace function get_gross_trends(p_fiscal_year int)
returns table(
  fiscal_year int,
  period_type text,
  period_key text,
  period_label text,
  sales numeric,
  cost numeric,
  gross numeric,
  gross_rate numeric,
  booking_count int
)
language sql stable
as $$
  with fy(y) as (values (p_fiscal_year), (p_fiscal_year - 1)),
  base as (
    select
      fy.y as fiscal_year,
      b.out_date,
      b.gross_sales,
      b.gross_cost,
      to_char(b.out_date, 'YYYY-MM') as month_key,
      (
        ((extract(year from b.out_date)::int * 12 + extract(month from b.out_date)::int)
         - (fy.y * 12 + 3)) / 3 + 1
      ) as quarter_num
    from fy
    join bookings b
      on b.out_date >= (fy.y || '-03-01')::date
     and b.out_date <  ((fy.y + 1) || '-03-01')::date
  )
  select
    fiscal_year,
    'month'::text as period_type,
    month_key as period_key,
    to_char(out_date, 'YYYY年MM月') as period_label,
    coalesce(sum(gross_sales), 0) as sales,
    coalesce(sum(gross_cost), 0) as cost,
    coalesce(sum(gross_sales), 0) - coalesce(sum(gross_cost), 0) as gross,
    case when sum(gross_sales) > 0
      then round((sum(gross_sales) - sum(gross_cost)) / sum(gross_sales) * 100, 1)
      else 0
    end as gross_rate,
    count(*)::int as booking_count
  from base
  group by fiscal_year, month_key, to_char(out_date, 'YYYY年MM月')
  union all
  select
    fiscal_year,
    'quarter'::text as period_type,
    'Q' || quarter_num as period_key,
    '第' || quarter_num || '四半期' as period_label,
    coalesce(sum(gross_sales), 0) as sales,
    coalesce(sum(gross_cost), 0) as cost,
    coalesce(sum(gross_sales), 0) - coalesce(sum(gross_cost), 0) as gross,
    case when sum(gross_sales) > 0
      then round((sum(gross_sales) - sum(gross_cost)) / sum(gross_sales) * 100, 1)
      else 0
    end as gross_rate,
    count(*)::int as booking_count
  from base
  group by fiscal_year, quarter_num
  order by 1 desc, 2, 3;
$$;

grant execute on function get_gross_trends(int) to anon, authenticated, service_role;

-- ── get_gross_top_tours: 指定決算年度の中で粗利額/粗利率が大きい・小さいツアーN件 ──
-- p_order: 'gross_desc'(粗利額が大きい順、既定) / 'gross_asc'(粗利額が小さい順) /
--          'rate_desc'(粗利率が高い順) / 'rate_asc'(粗利率が低い順)
-- 未知の値が渡された場合はgross_descとして扱う(CASE式がすべてNULLになりORDER BYの
-- 最終フォールバック句が効くため)。
create or replace function get_gross_top_tours(
  p_fiscal_year int,
  p_limit int default 10,
  p_order text default 'gross_desc'
)
returns table(
  id text,
  ref_no text,
  agent_name text,
  tour_name text,
  out_date date,
  sales numeric,
  cost numeric,
  gross numeric,
  gross_rate numeric
)
language sql stable
as $$
  select
    b.id::text as id,
    b.ref_no,
    b.agent_name,
    b.tour_name,
    b.out_date,
    coalesce(b.gross_sales, 0) as sales,
    coalesce(b.gross_cost, 0) as cost,
    coalesce(b.gross_sales, 0) - coalesce(b.gross_cost, 0) as gross,
    case when coalesce(b.gross_sales, 0) > 0
      then round((coalesce(b.gross_sales, 0) - coalesce(b.gross_cost, 0)) / b.gross_sales * 100, 1)
      else 0
    end as gross_rate
  from bookings b
  where b.out_date >= (p_fiscal_year || '-03-01')::date
    and b.out_date <  ((p_fiscal_year + 1) || '-03-01')::date
    and (coalesce(b.gross_sales, 0) <> 0 or coalesce(b.gross_cost, 0) <> 0)
  order by
    case when p_order = 'gross_asc' then (coalesce(b.gross_sales, 0) - coalesce(b.gross_cost, 0)) end asc,
    case when p_order = 'gross_desc' then (coalesce(b.gross_sales, 0) - coalesce(b.gross_cost, 0)) end desc,
    case when p_order = 'rate_asc' then
      (case when coalesce(b.gross_sales, 0) > 0
        then (coalesce(b.gross_sales, 0) - coalesce(b.gross_cost, 0)) / b.gross_sales else 0 end)
    end asc,
    case when p_order = 'rate_desc' then
      (case when coalesce(b.gross_sales, 0) > 0
        then (coalesce(b.gross_sales, 0) - coalesce(b.gross_cost, 0)) / b.gross_sales else 0 end)
    end desc,
    (coalesce(b.gross_sales, 0) - coalesce(b.gross_cost, 0)) desc
  limit greatest(p_limit, 0);
$$;

grant execute on function get_gross_top_tours(int, int, text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
