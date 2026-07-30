-- GROSS/粗利管理画面のサーバー側集計方式への切り替え。
--
-- 背景: 従来はfetchAllBookings()で全予約をブラウザに取得してから、
-- 決算年度・月別のGROSS集計をクライアント側(JS)で計算していた。
-- Access移行でbookingsが10万件規模に達すると、この方式は転送量・
-- 計算量とも非現実的になるため、月別のSUM+GROUP BYをSupabase側の
-- RPC関数で行い、結果(月別12行)だけをブラウザに返す方式に変更する。
--
-- bookings.gross_sales/gross_costは、予約詳細保存時にbooking_sales/
-- booking_costsの明細合計から都度再計算・書き戻しされている非正規化
-- キャッシュ値のため、本関数はbookingsテーブル単体のSUM+GROUP BYのみで
-- 完結する(booking_sales/booking_costsのJOIN・JSONB展開は不要)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

create or replace function get_gross_summary(p_fiscal_year int)
returns table(
  month text,
  sales numeric,
  cost numeric,
  gross numeric,
  gross_rate numeric,
  booking_count int
)
language sql stable
as $$
  select
    to_char(out_date, 'YYYY-MM')                                   as month,
    coalesce(sum(gross_sales), 0)                                  as sales,
    coalesce(sum(gross_cost), 0)                                   as cost,
    coalesce(sum(gross_sales), 0) - coalesce(sum(gross_cost), 0)   as gross,
    case when sum(gross_sales) > 0
      then round((sum(gross_sales) - sum(gross_cost)) / sum(gross_sales) * 100, 1)
      else 0
    end                                                              as gross_rate,
    count(*)::int                                                    as booking_count
  from bookings
  where out_date >= (p_fiscal_year || '-03-01')::date
    and out_date <  ((p_fiscal_year + 1) || '-03-01')::date
  group by to_char(out_date, 'YYYY-MM')
  order by month;
$$;

grant execute on function get_gross_summary(int) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
