-- 2026-09-24 調査・修正SQL(JUNがSupabase SQL Editorで実行)。
--   Part 1: 合算Invoiceの自動作成失敗(error_logs 35件)の原因確認と、合算が作れなかった予約の一覧(読み取り専用)
--   Part 2: #1069 の同名同日の観光施設行と仕入明細の紐付けの調査(読み取り専用。付け替え/削除SQLは結果確認後)
--   Part 3: (d)のうち8件の手配行のcost_addedをtrueにする(バックアップ→件数8件でなければ取り消すUPDATE→確認)
-- 使用列はscripts/create_error_logs_table.sql(error_logs)、既存のALTER/コード上の使用実績で確認済み。

-- ============================================================
-- Part 1-1: 35件のエラー内容(期待: error_messageに invoices_invoice_no_key / duplicate key が含まれる)
-- ============================================================
select created_at, user_email, error_message, left(error_detail, 300) as error_detail_head
from public.error_logs
where page_or_function = '合算Invoiceの自動更新'
order by created_at;

-- Part 1-2: エラー内容の分類件数(期待: invoice_no一意制約違反が35件)
select case when error_message ilike '%invoices_invoice_no_key%' then 'invoice_no一意制約違反'
            when error_message ilike '%duplicate key%'            then 'その他の一意制約違反'
            else 'その他' end as kind,
       count(*)
from public.error_logs
where page_or_function = '合算Invoiceの自動更新'
group by 1 order by 2 desc;

-- Part 1-3: 合算Invoiceが作れなかった予約(個別Invoiceはあるが、同じ通貨の合算Invoiceが無い)
--   error_logsには予約IDが残らないため、「個別Invoiceの発行時に必ず合算の自動作成が走る」ことを利用して判定する。
--   matched_errors: その予約の個別Invoiceの発行・再発行(audit_logs)の前後2分以内に、同じユーザーの
--   合算自動更新エラーがあった件数(35件との対応の目安)。
select b.ref_no, i.booking_id, i.currency,
       string_agg(i.invoice_no, ', ' order by i.invoice_no) as individual_invoice_nos,
       max(i.issue_date) as last_issue_date,
       (select count(*) from public.error_logs e
         where e.page_or_function = '合算Invoiceの自動更新'
           and exists (select 1 from public.audit_logs al
                       where al.table_name = 'invoices' and al.action in ('insert','update')
                         and (coalesce(al.after_data, al.before_data)->>'booking_id') = i.booking_id::text
                         and al.changed_by = e.user_email
                         and al.changed_at between e.created_at - interval '2 minutes' and e.created_at + interval '2 minutes')
       ) as matched_errors
from public.invoices i
left join public.bookings b on b.id = i.booking_id
where not i.is_consolidated
  and not exists (select 1 from public.invoices c
                  where c.booking_id = i.booking_id and c.is_consolidated and c.currency = i.currency)
group by b.ref_no, i.booking_id, i.currency
order by last_issue_date desc, b.ref_no;

-- ============================================================
-- Part 2-1: #1069 の観光施設行(全件)。同名同日の行が複数あるかを確認する
-- ============================================================
select f.id, f.facility_name, f.date, f.sort_order, f.status, f.cost_added, f.created_at,
       count(*) over (partition by f.facility_name, f.date) as same_name_date_rows,
       (select count(*) from public.booking_costs c
         where c.source_table = 'booking_facilities' and c.source_id = f.id) as linked_cost_rows
from public.booking_facilities f
where f.booking_id = '59674e70-3721-4458-8002-c3d60595d43d'
order by f.sort_order nulls last, f.created_at;

-- Part 2-2: #1069 の仕入明細(全件)と、紐付き先の手配行
--   source_snapshot は「追加した時点の追加元の名前・日付」。トロッコ/嵯峨野トロッコの名前違いの原因判定に使う
--   (snapshotが「嵯峨野トロッコ」なら追加後に手配側の名前が変わった、「トロッコ」なら仕入明細側で名前を編集した)。
select c.id, c.item_name, c.amount, c.payment_method, c.memo,
       c.source_table, c.source_id, c.source_snapshot, c.created_at,
       coalesce(f.facility_name, h.hotel_name, bu.bus_company, r.restaurant_name, w.item_name) as linked_name,
       coalesce(f.date::text, w.date::text, r.date::text)                                       as linked_date,
       coalesce(f.sort_order, w.sort_order, r.sort_order, h.sort_order, bu.sort_order)          as linked_sort_order
from public.booking_costs c
left join public.booking_facilities  f  on c.source_table = 'booking_facilities'  and f.id  = c.source_id
left join public.booking_hotels      h  on c.source_table = 'booking_hotels'      and h.id  = c.source_id
left join public.booking_buses       bu on c.source_table = 'booking_buses'       and bu.id = c.source_id
left join public.booking_restaurants r  on c.source_table = 'booking_restaurants' and r.id  = c.source_id
left join public.booking_water_items w  on c.source_table = 'booking_water_items' and w.id  = c.source_id
where c.booking_id = '59674e70-3721-4458-8002-c3d60595d43d'
order by c.created_at, c.id;

-- Part 2-3: 「トロッコ」関連の手配行・仕入明細と、手配側の名前変更履歴(audit_logs)
select 'facility' as kind, f.id, f.facility_name as name, f.date::text as date, f.sort_order, f.cost_added,
       null::jsonb as source_snapshot, null::uuid as source_id
from public.booking_facilities f
where f.booking_id = '59674e70-3721-4458-8002-c3d60595d43d' and f.facility_name like '%トロッコ%'
union all
select 'cost', c.id, c.item_name, null, null, null, c.source_snapshot, c.source_id
from public.booking_costs c
where c.booking_id = '59674e70-3721-4458-8002-c3d60595d43d' and c.item_name like '%トロッコ%'
order by kind, sort_order nulls last, name;

select changed_at, changed_by, action,
       before_data->>'facility_name' as before_name, after_data->>'facility_name' as after_name,
       coalesce(after_data->>'date', before_data->>'date') as date
from public.audit_logs
where table_name = 'booking_facilities'
  and coalesce(after_data->>'booking_id', before_data->>'booking_id') = '59674e70-3721-4458-8002-c3d60595d43d'
  and (before_data->>'facility_name' like '%トロッコ%' or after_data->>'facility_name' like '%トロッコ%')
order by changed_at;

-- 仕入明細側の名前編集の履歴(booking_costsはauditLog対象。replaceのたびに内容が変わった行のみ記録)
select changed_at, changed_by, action, before_data->>'item_name' as before_name, after_data->>'item_name' as after_name,
       coalesce(after_data->>'source_id', before_data->>'source_id') as source_id
from public.audit_logs
where table_name = 'booking_costs'
  and coalesce(after_data->>'booking_id', before_data->>'booking_id') = '59674e70-3721-4458-8002-c3d60595d43d'
  and (before_data->>'item_name' like '%トロッコ%' or after_data->>'item_name' like '%トロッコ%')
order by changed_at;

-- ============================================================
-- Part 3: (d)のうち8件の手配行のcost_addedをtrueにする
--   対象(JUN目視確認済み): #1120 8cefb89b / #1153 5b72eb33 / #1229 ee3cf08a, d50cc0ec /
--                          #534 7c32fe26, d63b94c9, c53533ae / #782 3ca6764d
--   #1069 77608c88(チームラボ2行目)はPart 2の調査対象のため除外。
--   条件: REF#の数字部分 + 手配行idの先頭8文字 の組 かつ (d)の条件(cost_added=false・紐付き無し・同名の仕入明細あり)
-- ============================================================
-- Part 3-1: バックアップ兼対象確認(期待: 8行。結果を保存しておく)
with arr as (
  select 'booking_hotels'::text as t, id, booking_id, hotel_name as name, cost_added from public.booking_hotels
  union all select 'booking_buses',       id, booking_id, bus_company,     cost_added from public.booking_buses
  union all select 'booking_restaurants', id, booking_id, restaurant_name, cost_added from public.booking_restaurants
  union all select 'booking_facilities',  id, booking_id, facility_name,   cost_added from public.booking_facilities
  union all select 'booking_water_items', id, booking_id, item_name,       cost_added from public.booking_water_items
),
wanted(ref_digits, id_prefix) as (values
  ('1120','8cefb89b'), ('1153','5b72eb33'), ('1229','ee3cf08a'), ('1229','d50cc0ec'),
  ('534','7c32fe26'),  ('534','d63b94c9'),  ('534','c53533ae'),  ('782','3ca6764d')
)
select b.ref_no, a.t as table_name, a.id, a.name, a.cost_added,
       (select json_agg(json_build_object('id', c.id, 'item_name', c.item_name, 'amount', c.amount, 'memo', c.memo))
          from public.booking_costs c where c.booking_id = a.booking_id and c.item_name = a.name) as same_name_costs
from arr a
join public.bookings b on b.id = a.booking_id
join wanted w on w.ref_digits = regexp_replace(b.ref_no, '[^0-9]', '', 'g') and a.id::text like w.id_prefix || '%'
where a.cost_added = false
  and not exists (select 1 from public.booking_costs c where c.source_table = a.t and c.source_id = a.id)
  and exists (select 1 from public.booking_costs c where c.booking_id = a.booking_id and c.item_name = a.name)
order by b.ref_no, a.t, a.name;

-- Part 3-2: 更新(1トランザクション。対象・更新件数が8件でなければ例外で全体を取り消す)
begin;

do $$
declare
  v_expected int := 8;
  v_target int;
  v_updated int := 0;
  v_n int;
begin
  create temp table _fix_d8_targets on commit drop as
  with arr as (
    select 'booking_hotels'::text as t, id, booking_id, hotel_name as name, cost_added from public.booking_hotels
    union all select 'booking_buses',       id, booking_id, bus_company,     cost_added from public.booking_buses
    union all select 'booking_restaurants', id, booking_id, restaurant_name, cost_added from public.booking_restaurants
    union all select 'booking_facilities',  id, booking_id, facility_name,   cost_added from public.booking_facilities
    union all select 'booking_water_items', id, booking_id, item_name,       cost_added from public.booking_water_items
  ),
  wanted(ref_digits, id_prefix) as (values
    ('1120','8cefb89b'), ('1153','5b72eb33'), ('1229','ee3cf08a'), ('1229','d50cc0ec'),
    ('534','7c32fe26'),  ('534','d63b94c9'),  ('534','c53533ae'),  ('782','3ca6764d')
  )
  select a.t, a.id
  from arr a
  join public.bookings b on b.id = a.booking_id
  join wanted w on w.ref_digits = regexp_replace(b.ref_no, '[^0-9]', '', 'g') and a.id::text like w.id_prefix || '%'
  where a.cost_added = false
    and not exists (select 1 from public.booking_costs c where c.source_table = a.t and c.source_id = a.id)
    and exists (select 1 from public.booking_costs c where c.booking_id = a.booking_id and c.item_name = a.name);

  select count(*) into v_target from _fix_d8_targets;
  if v_target <> v_expected then
    raise exception '対象件数が想定と異なります(対象=%件, 想定=%件)。何も変更せず中止します', v_target, v_expected;
  end if;

  update public.booking_hotels      set cost_added = true where id in (select id from _fix_d8_targets where t = 'booking_hotels')      and cost_added = false;
  get diagnostics v_n = row_count; v_updated := v_updated + v_n;
  update public.booking_buses       set cost_added = true where id in (select id from _fix_d8_targets where t = 'booking_buses')       and cost_added = false;
  get diagnostics v_n = row_count; v_updated := v_updated + v_n;
  update public.booking_restaurants set cost_added = true where id in (select id from _fix_d8_targets where t = 'booking_restaurants') and cost_added = false;
  get diagnostics v_n = row_count; v_updated := v_updated + v_n;
  update public.booking_facilities  set cost_added = true where id in (select id from _fix_d8_targets where t = 'booking_facilities')  and cost_added = false;
  get diagnostics v_n = row_count; v_updated := v_updated + v_n;
  update public.booking_water_items set cost_added = true where id in (select id from _fix_d8_targets where t = 'booking_water_items') and cost_added = false;
  get diagnostics v_n = row_count; v_updated := v_updated + v_n;

  if v_updated <> v_expected then
    raise exception '更新件数が想定と異なります(更新=%件, 想定=%件)。全体を取り消します', v_updated, v_expected;
  end if;
  raise notice '更新件数: %件(想定どおり)', v_updated;
end $$;

commit;

-- Part 3-3: 実行後確認(期待: 8行すべて cost_added = true)
with arr as (
  select 'booking_hotels'::text as t, id, booking_id, cost_added from public.booking_hotels
  union all select 'booking_buses',       id, booking_id, cost_added from public.booking_buses
  union all select 'booking_restaurants', id, booking_id, cost_added from public.booking_restaurants
  union all select 'booking_facilities',  id, booking_id, cost_added from public.booking_facilities
  union all select 'booking_water_items', id, booking_id, cost_added from public.booking_water_items
),
wanted(ref_digits, id_prefix) as (values
  ('1120','8cefb89b'), ('1153','5b72eb33'), ('1229','ee3cf08a'), ('1229','d50cc0ec'),
  ('534','7c32fe26'),  ('534','d63b94c9'),  ('534','c53533ae'),  ('782','3ca6764d')
)
select b.ref_no, a.t, a.id, a.cost_added
from arr a
join public.bookings b on b.id = a.booking_id
join wanted w on w.ref_digits = regexp_replace(b.ref_no, '[^0-9]', '', 'g') and a.id::text like w.id_prefix || '%'
order by b.ref_no, a.t;
