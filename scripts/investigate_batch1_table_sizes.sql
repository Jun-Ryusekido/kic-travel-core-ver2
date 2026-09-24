-- RLS対応フェーズ2 バッチ1: 全件取得している画面の件数・JSONサイズの確認(読み取り専用)。
-- API(/api/table-crud の query)は1レスポンス約3MBで打ち切って続きを返すため、
-- 「JSONサイズ合計 ÷ 3MB(切り上げ)」がその画面を開いた時のAPIリクエスト回数の目安になる。
-- json_bytes はAPIが実際に返すJSON(row_to_json)と同じ形式でのバイト数。
-- Supabaseダッシュボードの SQL Editor で実行する。

select 'booking_sales(item_name のみ: 売上明細の項目名候補)' as target,
       count(*) as row_count,
       sum(octet_length(json_build_object('item_name', item_name)::text)) as json_bytes,
       ceil(sum(octet_length(json_build_object('item_name', item_name)::text)) / (3.0 * 1024 * 1024)) as api_requests
from public.booking_sales
union all
select 'credit_card_statements(*: クレジットカード明細一覧)', count(*),
       sum(octet_length(row_to_json(t)::text)), ceil(sum(octet_length(row_to_json(t)::text)) / (3.0 * 1024 * 1024))
from public.credit_card_statements t
union all
select 'invoices(*: Invoice一覧・全件バックアップ)', count(*),
       sum(octet_length(row_to_json(t)::text)), ceil(sum(octet_length(row_to_json(t)::text)) / (3.0 * 1024 * 1024))
from public.invoices t
union all
select 'booking_sales(*: 全件バックアップ)', count(*),
       sum(octet_length(row_to_json(t)::text)), ceil(sum(octet_length(row_to_json(t)::text)) / (3.0 * 1024 * 1024))
from public.booking_sales t
union all
select 'booking_costs(*: 全件バックアップ)', count(*),
       sum(octet_length(row_to_json(t)::text)), ceil(sum(octet_length(row_to_json(t)::text)) / (3.0 * 1024 * 1024))
from public.booking_costs t
union all
select 'booking_costs(未精算の個人立替バナー)', count(*),
       sum(octet_length(json_build_object('id', id, 'amount', amount, 'card_holder', card_holder, 'booking_id', booking_id)::text)),
       ceil(coalesce(sum(octet_length(json_build_object('id', id, 'amount', amount, 'card_holder', card_holder, 'booking_id', booking_id)::text)), 0) / (3.0 * 1024 * 1024))
from public.booking_costs
where payment_method = 'クレジットカード(個人・要精算)' and payment_date is null;

-- 1予約あたりの最大行数(予約詳細を開く時のqueryBatchが1リクエストで完結するかの確認。
-- 3テーブル合計が約3MB未満なら1リクエスト。200件未満ならサーバー内のSupabase問い合わせも各1回)
select 'booking_sales' as t, max(n) as max_rows_per_booking from (select booking_id, count(*) n from public.booking_sales group by booking_id) x
union all
select 'booking_costs', max(n) from (select booking_id, count(*) n from public.booking_costs group by booking_id) x
union all
select 'invoices', max(n) from (select booking_id, count(*) n from public.invoices group by booking_id) x;
