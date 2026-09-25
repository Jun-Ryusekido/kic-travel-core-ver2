-- ホテル明細(booking_hotels)に区分「ゲスト/ドライバー」の列 lodging_for を追加し、ホテル予約管理の一覧・
-- キャンセル期日アラートのRPCからドライバー宿泊の行を除外する(2026-09-25 JUN決定: 案C)。
-- 既存の行はすべて 'guest'(ゲスト)になる(列の既定値)。既存テーブルへの列追加のため、GRANT/RLSの変更は無い。
--
-- 実行順(重要): このSQL(STEP 1〜3)を、コード(PR)をマージ・デプロイする「前」に実行する。
--   新しいコードは保存時に lodging_for を送り、ホテル予約管理は lodging_for で絞り込むため、列が無いと
--   ホテル明細の保存・ホテル予約管理の表示が失敗する。逆に、列を先に追加しても古いコードは影響を受けない
--   (送らない列は既定値 'guest' になる。ドライバーの行はまだ存在しない)。
--   Previewで確認する場合も、Previewは本番と同じDBを使うため、先にこのSQLが必要。
-- 1ブロック=1回の実行単位。JUNがSupabase SQL Editorで実行する。

-- ===== STEP 0(読み取り専用): 現在のRPC定義の確認 =====
-- 期待: 下の STEP 2 で置き換える前の定義が、scripts/create_guide_settlements_hotel_management_rpcs.sql と同じ
--       (本番で別途変更されていない)こと。違っていたら STEP 2 は実行せず、結果をClaudeに渡す。
select p.proname, pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('search_hotel_management', 'get_hotel_cancel_alert_counts');

-- ===== STEP 1: 列の追加(既存行は 'guest') =====
-- 期待: エラーなく完了。
alter table public.booking_hotels
  add column if not exists lodging_for text not null default 'guest';
alter table public.booking_hotels drop constraint if exists booking_hotels_lodging_for_check;
alter table public.booking_hotels
  add constraint booking_hotels_lodging_for_check check (lodging_for in ('guest', 'driver'));
comment on column public.booking_hotels.lodging_for is
  '区分: guest=ゲストの宿泊(既定) / driver=ドライバー宿泊(仮払いで精算。仕入明細・ホテル予約管理・キャンセル期日の警告・手配確定状況の対象外)';
notify pgrst, 'reload schema';

-- ===== STEP 2: RPC 2本からドライバー宿泊を除外(定義は STEP 0 と同じ内容 + lodging_for の条件のみ追加) =====
-- 期待: エラーなく完了。create or replace のため、既存のEXECUTE権限はそのまま残る。
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
    and lodging_for = 'guest'  -- ドライバー宿泊はKICが手配するものではないため対象外(2026-09-25)
  group by tier
  order by tier;
$$;

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
    h.lodging_for = 'guest'  -- ドライバー宿泊はKICが手配するものではないため対象外(2026-09-25)
    and (p_search is null or p_search = '' or h.hotel_name ilike '%'||p_search||'%' or b.ref_no ilike '%'||p_search||'%')
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

notify pgrst, 'reload schema';

-- ===== STEP 3(読み取り専用): 確認 =====
-- 期待: lodging_for は text / NOT NULL / 既定値 'guest'。
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'booking_hotels' and column_name = 'lodging_for';

-- 期待: guest が全件(実行直後は driver 0件)。
select lodging_for, count(*) from public.booking_hotels group by lodging_for order by lodging_for;

-- 期待: 2本とも定義に lodging_for を含む(true)。
select p.proname, pg_get_functiondef(p.oid) like '%lodging_for%' as excludes_driver
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('search_hotel_management', 'get_hotel_cancel_alert_counts');
