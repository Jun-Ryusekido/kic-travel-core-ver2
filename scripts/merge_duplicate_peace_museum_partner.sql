-- 取引先マスタの資料館の重複登録の統合(2026-09-28 JUN指示)。
--   本体   : 2dabf14a-9f57-4e81-8584-e70ec33cdc3b 広島平和記念資料館
--   重複   : c7d17aec-686d-4af6-ba45-3785f3ea15b2 平和記念資料館、原爆ﾄﾞｰﾑ､貞子碑
-- (idはJUNがSTEP 0で実行したSELECTの結果。M3bの中でも id・名前・削除状態が一致することを確認してから更新する)
--
-- 手順は scripts/merge_duplicate_business_partners.js(2026-08-26の重複統合)と同じ:
--   担当者(business_partner_contacts)を本体へ付け替え → 重複を論理削除(is_deleted=true、物理削除はしない)。
-- 予約の手配行の表記(facility_name等)は変更しない(別名で本体に紐付く)。
--
-- 順番: add_guide_notices_and_partner_aliases.sql の STEP 1 の後に実行する(新しいテーブルも付け替え対象のため)。
--       コードのデプロイ(施設名の候補から取引先IDを入れる版)より前に終えること。
-- Supabase SQL Editor で、Mごとに1回ずつ実行すること。

-- ===== M1: 重複を参照しているものの洗い出し(読み取り専用) =====
-- M1-1. 外部キーで business_partners を参照している全テーブル・列と、重複・本体それぞれの件数。
--   期待: business_partner_contacts 以外は 0(新しいテーブル・列はまだ空)。
select c.conrelid::regclass::text as table_name, a.attname as column_name,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s where %I = %L',
     c.conrelid::regclass, a.attname, 'c7d17aec-686d-4af6-ba45-3785f3ea15b2'), false, true, '')))[1]::text::int as n_duplicate,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s where %I = %L',
     c.conrelid::regclass, a.attname, '2dabf14a-9f57-4e81-8584-e70ec33cdc3b'), false, true, '')))[1]::text::int as n_main
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
where c.contype = 'f' and c.confrelid = 'public.business_partners'::regclass
order by 1, 2;

-- M1-2. 名前(文字列)で参照しているもの(外部キーではない。統合では変更しない。参考として件数を見る)。
select 'booking_facilities.facility_name' as ref, count(*) as n
  from public.booking_facilities where facility_name = '平和記念資料館、原爆ﾄﾞｰﾑ､貞子碑'
union all
select 'facility_operating_info(重複の名前)', count(*)
  from public.facility_operating_info where facility_name = '平和記念資料館、原爆ﾄﾞｰﾑ､貞子碑'
union all
select 'facility_operating_info(本体の名前)', count(*)
  from public.facility_operating_info where facility_name = '広島平和記念資料館'
union all
select 'learned_mappings.confirmed_value', count(*)
  from public.learned_mappings where confirmed_value in ('平和記念資料館、原爆ﾄﾞｰﾑ､貞子碑', '広島平和記念資料館');

-- ===== M2: 本体と重複の比較(読み取り専用) =====
-- M2-1. 取引先の行(住所・英語名・備考等)。重複にしか無い情報があれば、統合の前に本体へ画面から転記する(このSQLでは移さない)。
select * from public.business_partners
where id in ('2dabf14a-9f57-4e81-8584-e70ec33cdc3b', 'c7d17aec-686d-4af6-ba45-3785f3ea15b2')
order by (id = '2dabf14a-9f57-4e81-8584-e70ec33cdc3b') desc;

-- M2-2. 担当者(電話・メール等)。重複側の担当者は M3b で本体に付け替わる(本体に代表担当者がいれば、移した担当者は代表にしない)。
select business_partner_id = '2dabf14a-9f57-4e81-8584-e70ec33cdc3b' as is_main, *
from public.business_partner_contacts
where business_partner_id in ('2dabf14a-9f57-4e81-8584-e70ec33cdc3b', 'c7d17aec-686d-4af6-ba45-3785f3ea15b2')
order by is_main desc, is_deleted, created_at;

-- M2-3. 営業時間情報(名前で紐付くもの)。
select * from public.facility_operating_info
where facility_name in ('広島平和記念資料館', '平和記念資料館、原爆ﾄﾞｰﾑ､貞子碑');

-- ===== M3a: バックアップ(読み取り専用) =====
-- 結果(JSON)を保存し、n_contacts と n_other(別名・注意事項・観光施設の行の合計)を Claude に伝える。M3b の件数ガードに使う。
select
  (select count(*) from public.business_partner_contacts where business_partner_id = 'c7d17aec-686d-4af6-ba45-3785f3ea15b2') as n_contacts,
  (select count(*) from public.business_partner_aliases where business_partner_id = 'c7d17aec-686d-4af6-ba45-3785f3ea15b2')
  + (select count(*) from public.business_partner_guide_notices where business_partner_id = 'c7d17aec-686d-4af6-ba45-3785f3ea15b2')
  + (select count(*) from public.booking_facilities where business_partner_id = 'c7d17aec-686d-4af6-ba45-3785f3ea15b2') as n_other,
  json_build_object(
    'business_partners', (select json_agg(bp) from public.business_partners bp
                          where id in ('2dabf14a-9f57-4e81-8584-e70ec33cdc3b', 'c7d17aec-686d-4af6-ba45-3785f3ea15b2')),
    'business_partner_contacts', (select json_agg(bc) from public.business_partner_contacts bc
                          where business_partner_id in ('2dabf14a-9f57-4e81-8584-e70ec33cdc3b', 'c7d17aec-686d-4af6-ba45-3785f3ea15b2')),
    'business_partner_aliases', (select json_agg(x) from public.business_partner_aliases x
                          where business_partner_id = 'c7d17aec-686d-4af6-ba45-3785f3ea15b2'),
    'business_partner_guide_notices', (select json_agg(x) from public.business_partner_guide_notices x
                          where business_partner_id = 'c7d17aec-686d-4af6-ba45-3785f3ea15b2'),
    'booking_facilities', (select json_agg(x) from public.booking_facilities x
                          where business_partner_id = 'c7d17aec-686d-4af6-ba45-3785f3ea15b2')
  ) as backup;

-- ===== M3b: 統合(件数ガード付き) =====
-- <M3aのn_contacts> と <M3aのn_other> を M3a の結果に置き換えてから実行する。
-- 本体・重複の id・名前・削除状態が想定と違う場合、または件数が一致しない場合は、何も変更せずエラーで止まる。
do $$
declare
  c_main constant uuid := '2dabf14a-9f57-4e81-8584-e70ec33cdc3b';
  c_dup  constant uuid := 'c7d17aec-686d-4af6-ba45-3785f3ea15b2';
  v_expected_contacts int := <M3aのn_contacts>;
  v_expected_other int := <M3aのn_other>;
  v_main_has_primary boolean;
  v_n int;
  v_other int := 0;
begin
  perform 1 from public.business_partners
   where id = c_main and company_name = '広島平和記念資料館' and coalesce(is_deleted, false) = false;
  if not found then raise exception '本体(2dabf14a…)が「広島平和記念資料館」・有効の状態ではありません。中止しました。'; end if;
  perform 1 from public.business_partners
   where id = c_dup and company_name = '平和記念資料館、原爆ﾄﾞｰﾑ､貞子碑' and coalesce(is_deleted, false) = false;
  if not found then raise exception '重複(c7d17aec…)が想定の名前・有効の状態ではありません。中止しました。'; end if;

  select exists (select 1 from public.business_partner_contacts
                  where business_partner_id = c_main and is_primary and not is_deleted)
    into v_main_has_primary;

  -- 担当者の付け替え(本体に代表担当者がいれば、移した担当者は代表にしない)
  update public.business_partner_contacts
     set business_partner_id = c_main,
         is_primary = case when v_main_has_primary then false else is_primary end,
         updated_at = now()
   where business_partner_id = c_dup;
  get diagnostics v_n = row_count;
  if v_n <> v_expected_contacts then
    raise exception '担当者の付け替え件数 % が M3a の件数 % と一致しません。取り消しました。', v_n, v_expected_contacts;
  end if;

  -- 新しいテーブル・列の付け替え(通常は0件)
  update public.business_partner_aliases set business_partner_id = c_main, updated_at = now() where business_partner_id = c_dup;
  get diagnostics v_n = row_count; v_other := v_other + v_n;
  update public.business_partner_guide_notices set business_partner_id = c_main, updated_at = now() where business_partner_id = c_dup;
  get diagnostics v_n = row_count; v_other := v_other + v_n;
  update public.booking_facilities set business_partner_id = c_main where business_partner_id = c_dup;
  get diagnostics v_n = row_count; v_other := v_other + v_n;
  if v_other <> v_expected_other then
    raise exception '別名・注意事項・観光施設の付け替え件数 % が M3a の件数 % と一致しません。取り消しました。', v_other, v_expected_other;
  end if;

  -- 重複の論理削除
  update public.business_partners
     set is_deleted = true, deleted_at = now(), deleted_by = 'merge_duplicate_partner_20260928', updated_at = now()
   where id = c_dup and coalesce(is_deleted, false) = false;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception '重複の論理削除が % 件でした(1件であること)。取り消しました。', v_n; end if;

  raise notice '統合しました: 担当者 % 件、その他 % 件を本体へ付け替え、重複を論理削除。', v_expected_contacts, v_other;
end $$;

-- ===== M3c: 確認(読み取り専用) =====
-- 期待: 重複は is_deleted=true・deleted_by='merge_duplicate_partner_20260928'。重複を参照する行は全テーブルで0件。
--       本体の担当者に移した担当者が加わり、有効な代表担当者(is_primary)は1人以下。
select id, company_name, is_deleted, deleted_at, deleted_by from public.business_partners
where id in ('2dabf14a-9f57-4e81-8584-e70ec33cdc3b', 'c7d17aec-686d-4af6-ba45-3785f3ea15b2');

select c.conrelid::regclass::text as table_name, a.attname as column_name,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s where %I = %L',
     c.conrelid::regclass, a.attname, 'c7d17aec-686d-4af6-ba45-3785f3ea15b2'), false, true, '')))[1]::text::int as n_duplicate
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
where c.contype = 'f' and c.confrelid = 'public.business_partners'::regclass
order by 1, 2;

select id, contact_person, phone, email, is_primary, is_deleted
from public.business_partner_contacts
where business_partner_id = '2dabf14a-9f57-4e81-8584-e70ec33cdc3b'
order by is_primary desc, is_deleted, created_at;
