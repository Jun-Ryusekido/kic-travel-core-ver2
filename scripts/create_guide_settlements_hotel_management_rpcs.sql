-- ガイド精算一覧・ホテル管理をサーバー側集計方式に切り替えるためのRPC関数。
--
-- 背景: 従来はguide_settlement_items/booking_hotelsを全件取得してから
-- クライアント側(JS)で合計・件数集計を行っていた。Access移行で件数が
-- 増加すると転送量・計算量とも非現実的になるため、SUM/COUNT等の集計を
-- Supabase側のRPC関数で行い、結果だけをブラウザに返す方式に変更する。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

-- ===== ガイド精算一覧 =====
-- 各settlementごとに、guide_settlement_items側でcategory別のSUM(status<>'rejected'のみ)、
-- guide_names(JSONB配列)またはsettlement本体の仮払金カラムのフォールバックで
-- 仮払金合計を計算する。p_statusで受付中/締め済/両方(null)を絞り込む。
create or replace function get_guide_settlements_summary(p_status text default null)
returns table(
  id uuid,
  booking_ref text,
  guide_name text,
  guide_phone text,
  status text,
  item_count int,
  local_total numeric,
  guide_fee_total numeric,
  advance_total numeric
)
language sql stable
as $$
  select
    s.id, s.booking_ref, s.guide_name, s.guide_phone, s.status,
    coalesce(item_agg.item_count, 0)::int   as item_count,
    coalesce(item_agg.local_total, 0)       as local_total,
    coalesce(item_agg.guide_fee_total, 0)   as guide_fee_total,
    case
      when advance_agg.guide_count > 0 then coalesce(advance_agg.advance_total, 0)
      else coalesce(s.advance_payment,0) + coalesce(s.additional_advance_payment,0)
    end as advance_total
  from guide_settlements s
  left join lateral (
    select
      count(*) as item_count,
      sum(amount) filter (where category not like '%ガイド費%') as local_total,
      sum(amount) filter (where category like '%ガイド費%')     as guide_fee_total
    from guide_settlement_items i
    where i.settlement_id = s.id and i.status <> 'rejected'
  ) item_agg on true
  left join lateral (
    select
      count(*) as guide_count,
      sum(coalesce((g->>'advance_payment')::numeric,0) + coalesce((g->>'additional_advance_payment')::numeric,0)) as advance_total
    from jsonb_array_elements(coalesce(s.guide_names,'[]'::jsonb)) as g
  ) advance_agg on true
  where (p_status is null or s.status = p_status)
  order by s.created_at desc;
$$;

grant execute on function get_guide_settlements_summary(text) to anon, authenticated, service_role;

-- ===== ホテル管理 =====
-- キャンセル期限アラートの期日ティア別件数(サーバー側COUNT+CASE)。
create or replace function get_hotel_cancel_alert_counts()
returns table(tier int, cnt int)
language sql stable
as $$
  select
    case
      when (check_in - current_date) <= 14 then 14
      when (check_in - current_date) <= 30 then 30
      when (check_in - current_date) <= 60 then 60
      else 90
    end as tier,
    count(*)::int as cnt
  from booking_hotels
  where status <> '手配OK' and check_in is not null and check_in >= current_date and (check_in - current_date) <= 90
  group by tier
  order by tier;
$$;

grant execute on function get_hotel_cancel_alert_counts() to anon, authenticated, service_role;

-- ホテル管理一覧本体の検索・日付・キャンセル期日ティア絞り込み(JOIN込みでSQL側実行)。
create or replace function search_hotel_management(
  p_search text default null,
  p_from date default null,
  p_to date default null,
  p_cancel_tier int default null
)
returns table(
  id uuid, booking_id uuid, hotel_name text, check_in date, check_out date,
  room_type text, rooms int, breakfast boolean, unit_price numeric, amount numeric,
  confirmation_no text, status text, status_updated_at timestamptz,
  ref_no text, agent_name text, tour_name text, pax int
)
language sql stable
as $$
  select
    h.id, h.booking_id, h.hotel_name, h.check_in, h.check_out, h.room_type, h.rooms,
    h.breakfast, h.unit_price, h.amount, h.confirmation_no, h.status, h.status_updated_at,
    b.ref_no, b.agent_name, b.tour_name, b.pax
  from booking_hotels h
  left join bookings b on b.id = h.booking_id
  where
    (p_search is null or p_search = '' or h.hotel_name ilike '%'||p_search||'%' or b.ref_no ilike '%'||p_search||'%')
    and (p_from is null or h.check_in >= p_from)
    and (p_to is null or h.check_in <= p_to)
    and (
      p_cancel_tier is null or (
        h.status <> '手配OK' and h.check_in >= current_date and
        case p_cancel_tier
          when 14 then (h.check_in - current_date) between 0 and 14
          when 30 then (h.check_in - current_date) between 15 and 30
          when 60 then (h.check_in - current_date) between 31 and 60
          when 90 then (h.check_in - current_date) between 61 and 90
          else true
        end
      )
    )
    and (
      (p_search is not null and p_search <> '') or p_from is not null or p_to is not null or p_cancel_tier is not null
      or h.check_out is null or h.check_out >= current_date
    )
  -- h.idはページング(.range())の境界を跨いでも順序が安定するよう、
  -- check_inの同値(タイ)を一意に決着させるための並び替えキー。
  order by h.check_in asc, h.id;
$$;

grant execute on function search_hotel_management(text, date, date, int) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
