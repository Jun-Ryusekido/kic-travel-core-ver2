-- 調査2(c)(d): 手配行のcost_addedと仕入明細(booking_costs)の紐付けのずれの内訳(2026-09)。
-- すべて読み取り専用。修正SQLは含まない(扱いは内訳を見てから個別に判断する)。
-- Supabaseダッシュボードの SQL Editor で実行すること。
--
-- 用語:
--   紐付き   : booking_costs.source_table = 手配テーブル名 かつ booking_costs.source_id = 手配行id
--   同名行   : 同じ予約(booking_id)に、item_name = 手配行の名前(施設名等) の仕入明細行がある
--   自動反映行: 仕入明細のmemoが「…手配から自動反映」(「仕入明細へ追加」ボタンで作られた行の目印)
-- 経緯(手がかり):
--   2026-07-23 cost_added列と「仕入明細へ一括反映」を追加(この時点では紐付け列が無い)
--   2026-08-05 booking_costsにsource_table/source_id/source_snapshotを追加(以後の追加は紐付く)
--   → 紐付け列の無い時期に追加された行は、cost_added=trueでも紐付きの仕入明細が存在しない。
--     その場合、同じ予約に「紐付け無し(source_id NULL)の同名行」が残っているはず。
-- 使用列: bookings.ref_no / in_date / out_date(in_date/out_dateはコード上の使用実績のみで確認。
--   エラーになる場合は列名を共有してください)。

-- ============================================================
-- (c) cost_added = true なのに紐付きの仕入明細が無い手配行(実データで133件)の内訳
-- ============================================================
-- (c-1) テーブル別 × 分類 × ツアー日程(過去/未来) の件数
with arr as (
  select 'booking_hotels'::text as t, id, booking_id, hotel_name as name, cost_added from public.booking_hotels
  union all select 'booking_buses',       id, booking_id, bus_company,     cost_added from public.booking_buses
  union all select 'booking_restaurants', id, booking_id, restaurant_name, cost_added from public.booking_restaurants
  union all select 'booking_facilities',  id, booking_id, facility_name,   cost_added from public.booking_facilities
  union all select 'booking_water_items', id, booking_id, item_name,       cost_added from public.booking_water_items
),
c_rows as (
  select a.*, b.ref_no,
         coalesce(nullif(b.out_date::text, ''), nullif(b.in_date::text, ''))::date as tour_end,
         -- 同じ予約の同名行のうち、紐付け無し(source_id NULL)のもの
         exists (select 1 from public.booking_costs c where c.booking_id = a.booking_id and c.item_name = a.name
                 and c.source_id is null) as same_name_unlinked,
         -- 同じ予約の同名行のうち、別の手配行id(同名同日の兄弟行等)に紐付いているもの
         exists (select 1 from public.booking_costs c where c.booking_id = a.booking_id and c.item_name = a.name
                 and c.source_id is not null and c.source_id <> a.id) as same_name_linked_elsewhere,
         -- 同じ予約に、この手配テーブル由来の自動反映行(memo)があるが名前が違う(仕入明細側で名前を編集した可能性)
         exists (select 1 from public.booking_costs c where c.booking_id = a.booking_id and c.item_name <> a.name
                 and c.memo like '%手配から自動反映%'
                 and (c.source_table = a.t or c.source_table is null)
                 and not exists (select 1 from public.booking_costs c3 where c3.booking_id = a.booking_id and c3.item_name = a.name)) as renamed_auto_row_candidate
  from arr a
  left join public.bookings b on b.id = a.booking_id
  where a.cost_added = true
    and not exists (select 1 from public.booking_costs c where c.source_table = a.t and c.source_id = a.id)
)
select t as table_name,
       case
         when same_name_unlinked         then 'G1 同名の紐付け無し行あり(紐付け列追加前の追加 or 付け替え失敗でnull化)'
         when same_name_linked_elsewhere then 'G2 同名行が別の手配行に紐付き(同名同日の付け替え取り違え)'
         when renamed_auto_row_candidate then 'G3 同名行なし・名前違いの自動反映行あり(仕入明細側で名前を編集した可能性)'
         else                                 'G4 同名行も自動反映行も無し(仕入明細行を削除した可能性が高い)'
       end as grp,
       case when tour_end is null then '日程不明'
            when tour_end < (now() at time zone 'Asia/Tokyo')::date then '過去'
            else '未来(当日含む)' end as tour_timing,
       count(*) as cnt
from c_rows
group by 1, 2, 3
order by 1, 2, 3;

-- (c-2) 合計の確認(期待: 133)
with arr as (
  select 'booking_hotels'::text as t, id, cost_added from public.booking_hotels
  union all select 'booking_buses',       id, cost_added from public.booking_buses
  union all select 'booking_restaurants', id, cost_added from public.booking_restaurants
  union all select 'booking_facilities',  id, cost_added from public.booking_facilities
  union all select 'booking_water_items', id, cost_added from public.booking_water_items
)
select count(*) as total_c
from arr a
where a.cost_added = true
  and not exists (select 1 from public.booking_costs c where c.source_table = a.t and c.source_id = a.id);

-- (c-3) 未来のツアーのG3/G4だけの明細(実務上の対応対象の目視確認用)
with arr as (
  select 'booking_hotels'::text as t, id, booking_id, hotel_name as name, cost_added from public.booking_hotels
  union all select 'booking_buses',       id, booking_id, bus_company,     cost_added from public.booking_buses
  union all select 'booking_restaurants', id, booking_id, restaurant_name, cost_added from public.booking_restaurants
  union all select 'booking_facilities',  id, booking_id, facility_name,   cost_added from public.booking_facilities
  union all select 'booking_water_items', id, booking_id, item_name,       cost_added from public.booking_water_items
)
select b.ref_no, coalesce(nullif(b.out_date::text,''), nullif(b.in_date::text,'')) as tour_end, a.t as table_name, a.id as arrangement_id, a.name,
       (select string_agg(c.item_name || ' / ' || coalesce(c.memo,''), ' | ' order by c.created_at)
          from public.booking_costs c where c.booking_id = a.booking_id and c.memo like '%手配から自動反映%') as auto_rows_in_booking
from arr a
join public.bookings b on b.id = a.booking_id
where a.cost_added = true
  and not exists (select 1 from public.booking_costs c where c.source_table = a.t and c.source_id = a.id)
  and not exists (select 1 from public.booking_costs c where c.booking_id = a.booking_id and c.item_name = a.name)
  and coalesce(nullif(b.out_date::text,''), nullif(b.in_date::text,''))::date >= (now() at time zone 'Asia/Tokyo')::date
order by tour_end, b.ref_no, a.t, a.name;

-- ============================================================
-- (d) cost_added = false・紐付き無し・同じ予約に同名の仕入明細行がある手配行(実データで9件)
--     JUNの目視確認用: 予約番号・手配行・同名の仕入明細行を並べる
-- ============================================================
with arr as (
  select 'booking_hotels'::text as t, id, booking_id, hotel_name as name, cost_added from public.booking_hotels
  union all select 'booking_buses',       id, booking_id, bus_company,     cost_added from public.booking_buses
  union all select 'booking_restaurants', id, booking_id, restaurant_name, cost_added from public.booking_restaurants
  union all select 'booking_facilities',  id, booking_id, facility_name,   cost_added from public.booking_facilities
  union all select 'booking_water_items', id, booking_id, item_name,       cost_added from public.booking_water_items
)
select b.ref_no, coalesce(nullif(b.out_date::text,''), nullif(b.in_date::text,'')) as tour_end,
       a.t as table_name, a.id as arrangement_id, a.name as arrangement_name,
       c.id as cost_id, c.item_name as cost_item_name, c.amount, c.memo,
       c.source_table, c.source_id, c.created_at as cost_created_at
from arr a
join public.bookings b on b.id = a.booking_id
join public.booking_costs c on c.booking_id = a.booking_id and c.item_name = a.name
where a.cost_added = false
  and not exists (select 1 from public.booking_costs c2 where c2.source_table = a.t and c2.source_id = a.id)
order by b.ref_no, a.t, a.name, c.created_at;
