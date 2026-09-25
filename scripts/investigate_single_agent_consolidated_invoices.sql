-- 請求先(agent)が1社以下の予約に作られている合算Invoice(is_consolidated = true)の一覧(読み取り専用)。
-- 背景: PR #209 以降、請求先が1社だけの予約でも個別Invoiceを発行するたびに合算Invoice(-ALL)が
-- 自動作成され、個別と同じ内容の請求書がInvoice一覧に2件並んでいた(本番 #877、2026-09-25発行で発生)。
-- PR #210 の追加修正で、合算は売上明細の請求先が2社以上の予約だけ作成・更新するようにした。
-- 既に作られた分は自動削除しないため、この一覧をJUNが確認してから削除SQLを別途用意する。
--
-- 請求先の数え方は index.html の distinctBookingAgents と同じ:
--   売上明細(booking_sales)の agent_name(前後の空白を除く)。空欄の行は予約(bookings)の agent_name として数える。
--   どちらも空欄の行は数えない。売上明細が0件の予約は 0社。
-- Supabaseダッシュボードの SQL Editor で実行する。

with sales_agents as (
  select b.id as booking_id,
         count(distinct coalesce(nullif(btrim(bs.agent_name, E' \t\r\n　'), ''),
                                 nullif(btrim(b.agent_name,  E' \t\r\n　'), ''))) as agent_count
  from public.bookings b
  left join public.booking_sales bs on bs.booking_id = b.id
  group by b.id
)
select b.ref_no                                   as booking_ref_no,
       sa.agent_count                             as sales_agent_count,
       i.invoice_no                               as consolidated_invoice_no,
       i.currency                                 as consolidated_currency,
       i.issue_date                               as consolidated_issue_date,
       i.status                                   as consolidated_status,
       i.amount                                   as consolidated_amount,
       (select string_agg(ind.invoice_no || ' (' || ind.currency || ', ' || ind.status || ')', ' / ' order by ind.invoice_no)
          from public.invoices ind
         where ind.booking_id = i.booking_id and ind.is_consolidated = false) as individual_invoices,
       i.id                                       as consolidated_invoice_id
from public.invoices i
join public.bookings b on b.id = i.booking_id
join sales_agents sa on sa.booking_id = i.booking_id
where i.is_consolidated = true
  and sa.agent_count < 2
order by i.issue_date desc, b.ref_no, i.currency;

-- 件数の内訳(参考): 合算Invoiceの総数と、そのうち請求先1社以下の予約のもの
with sales_agents as (
  select b.id as booking_id,
         count(distinct coalesce(nullif(btrim(bs.agent_name, E' \t\r\n　'), ''),
                                 nullif(btrim(b.agent_name,  E' \t\r\n　'), ''))) as agent_count
  from public.bookings b
  left join public.booking_sales bs on bs.booking_id = b.id
  group by b.id
)
select count(*)                                          as consolidated_total,
       count(*) filter (where sa.agent_count < 2)        as consolidated_single_agent,
       count(*) filter (where sa.agent_count >= 2)       as consolidated_multi_agent,
       count(*) filter (where sa.agent_count < 2 and i.status = 'paid') as single_agent_paid
from public.invoices i
join sales_agents sa on sa.booking_id = i.booking_id
where i.is_consolidated = true;
