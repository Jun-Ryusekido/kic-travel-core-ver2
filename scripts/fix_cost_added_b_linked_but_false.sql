-- 調査2(b): 手配行のcost_added=falseなのに、その行に紐付いた仕入明細(booking_costs.source_table/
-- source_id)が存在するものを、cost_added=trueへ直す(2026-09、実データで仕入明細側17件)。
-- 主因: 2026-09のRLS対応フェーズ1(PR #206)以前、「仕入明細へ追加」のcost_added更新がanonキーの
-- 直接UPDATEで、anonのUPDATE権限剥奪後に失敗し続けていた(仕入明細行の追加自体は成功)。
--
-- Supabaseダッシュボードの SQL Editor で、上から順に実行すること。
-- CLAUDE.mdの「削除・一括更新を伴う操作」の4ステップに従う:
--   (1) STEP1の結果(JSON)をバックアップとして保存
--   (2) STEP2の件数・内容をJUNが確認
--   (3) STEP3(UPDATE)を実行。件数が一致しなければ自動で取り消される
--   (4) STEP4で0件になったことを確認
-- 注意: SQLでの直接更新はaudit_logsに記録されない(記録はapi/table-crud.js経由の操作のみ)。
-- 実行後は画面をハードリロードして確認すること(5分TTLキャッシュのため)。

-- 共通の対象条件(STEP1〜4で同一):
--   手配5テーブルのうち cost_added = false で、
--   booking_costs に source_table = そのテーブル かつ source_id = その行id の行が1件以上ある。

-- ============================================================
-- STEP1: バックアップ(対象の手配行と紐付く仕入明細行をJSONで取得。結果を保存しておく)
-- ============================================================
with arr as (
  select 'booking_hotels'::text as t, id, booking_id, hotel_name as name, cost_added from public.booking_hotels
  union all select 'booking_buses',       id, booking_id, bus_company,     cost_added from public.booking_buses
  union all select 'booking_restaurants', id, booking_id, restaurant_name, cost_added from public.booking_restaurants
  union all select 'booking_facilities',  id, booking_id, facility_name,   cost_added from public.booking_facilities
  union all select 'booking_water_items', id, booking_id, item_name,       cost_added from public.booking_water_items
)
select json_agg(json_build_object(
  'table', a.t, 'id', a.id, 'booking_id', a.booking_id, 'name', a.name, 'cost_added', a.cost_added,
  'linked_costs', (select json_agg(json_build_object('id', c.id, 'item_name', c.item_name, 'amount', c.amount, 'memo', c.memo, 'created_at', c.created_at))
                   from public.booking_costs c where c.source_table = a.t and c.source_id = a.id)
)) as backup_json
from arr a
where a.cost_added = false
  and exists (select 1 from public.booking_costs c where c.source_table = a.t and c.source_id = a.id);

-- ============================================================
-- STEP2: 対象一覧(目視確認用)と件数
--   前回の(b)は「仕入明細行」の数(17件)。ここでは更新対象の「手配行」の数も出す
--   (1つの手配行に仕入明細行が2件以上紐付いていれば、手配行の数は17件より少なくなる)。
-- ============================================================
with arr as (
  select 'booking_hotels'::text as t, id, booking_id, hotel_name as name, cost_added from public.booking_hotels
  union all select 'booking_buses',       id, booking_id, bus_company,     cost_added from public.booking_buses
  union all select 'booking_restaurants', id, booking_id, restaurant_name, cost_added from public.booking_restaurants
  union all select 'booking_facilities',  id, booking_id, facility_name,   cost_added from public.booking_facilities
  union all select 'booking_water_items', id, booking_id, item_name,       cost_added from public.booking_water_items
)
select b.ref_no, a.t as table_name, a.id as arrangement_id, a.name,
       (select count(*) from public.booking_costs c where c.source_table = a.t and c.source_id = a.id) as linked_cost_rows
from arr a
left join public.bookings b on b.id = a.booking_id
where a.cost_added = false
  and exists (select 1 from public.booking_costs c where c.source_table = a.t and c.source_id = a.id)
order by b.ref_no, a.t, a.name;

-- 件数(期待: linked_cost_rows_total = 17。arrangement_rows = STEP3で指定する件数)
with arr as (
  select 'booking_hotels'::text as t, id, cost_added from public.booking_hotels
  union all select 'booking_buses',       id, cost_added from public.booking_buses
  union all select 'booking_restaurants', id, cost_added from public.booking_restaurants
  union all select 'booking_facilities',  id, cost_added from public.booking_facilities
  union all select 'booking_water_items', id, cost_added from public.booking_water_items
)
select count(*) as arrangement_rows,
       sum((select count(*) from public.booking_costs c where c.source_table = a.t and c.source_id = a.id)) as linked_cost_rows_total
from arr a
where a.cost_added = false
  and exists (select 1 from public.booking_costs c where c.source_table = a.t and c.source_id = a.id);

-- ============================================================
-- STEP3: 更新(1トランザクション)。v_expected にSTEP2の arrangement_rows の値を入れてから実行する。
--   STEP1/2と同じ条件で対象を確定 → 件数がv_expectedと一致しなければ例外で全体を取り消す。
-- ============================================================
begin;

do $$
declare
  v_expected int := 17;   -- ← STEP2の arrangement_rows の値に置き換える(仕入明細側17件と異なる場合がある)
  v_target int;
  v_updated int := 0;
  v_n int;
begin
  create temp table _fix_b_targets on commit drop as
  with arr as (
    select 'booking_hotels'::text as t, id, cost_added from public.booking_hotels
    union all select 'booking_buses',       id, cost_added from public.booking_buses
    union all select 'booking_restaurants', id, cost_added from public.booking_restaurants
    union all select 'booking_facilities',  id, cost_added from public.booking_facilities
    union all select 'booking_water_items', id, cost_added from public.booking_water_items
  )
  select a.t, a.id from arr a
  where a.cost_added = false
    and exists (select 1 from public.booking_costs c where c.source_table = a.t and c.source_id = a.id);

  select count(*) into v_target from _fix_b_targets;
  if v_target <> v_expected then
    raise exception '対象件数が想定と異なります(対象=%件, 想定=%件)。何も変更せず中止します', v_target, v_expected;
  end if;

  update public.booking_hotels      set cost_added = true where id in (select id from _fix_b_targets where t = 'booking_hotels')      and cost_added = false;
  get diagnostics v_n = row_count; v_updated := v_updated + v_n;
  update public.booking_buses       set cost_added = true where id in (select id from _fix_b_targets where t = 'booking_buses')       and cost_added = false;
  get diagnostics v_n = row_count; v_updated := v_updated + v_n;
  update public.booking_restaurants set cost_added = true where id in (select id from _fix_b_targets where t = 'booking_restaurants') and cost_added = false;
  get diagnostics v_n = row_count; v_updated := v_updated + v_n;
  update public.booking_facilities  set cost_added = true where id in (select id from _fix_b_targets where t = 'booking_facilities')  and cost_added = false;
  get diagnostics v_n = row_count; v_updated := v_updated + v_n;
  update public.booking_water_items set cost_added = true where id in (select id from _fix_b_targets where t = 'booking_water_items') and cost_added = false;
  get diagnostics v_n = row_count; v_updated := v_updated + v_n;

  if v_updated <> v_expected then
    raise exception '更新件数が想定と異なります(更新=%件, 想定=%件)。全体を取り消します', v_updated, v_expected;
  end if;
  raise notice '更新件数: %件(想定どおり)', v_updated;
end $$;

commit;

-- ============================================================
-- STEP4: 実行後確認(期待: 0件)
-- ============================================================
with arr as (
  select 'booking_hotels'::text as t, id, cost_added from public.booking_hotels
  union all select 'booking_buses',       id, cost_added from public.booking_buses
  union all select 'booking_restaurants', id, cost_added from public.booking_restaurants
  union all select 'booking_facilities',  id, cost_added from public.booking_facilities
  union all select 'booking_water_items', id, cost_added from public.booking_water_items
)
select count(*) as remaining
from arr a
where a.cost_added = false
  and exists (select 1 from public.booking_costs c where c.source_table = a.t and c.source_id = a.id);
