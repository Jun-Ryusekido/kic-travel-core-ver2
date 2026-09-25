-- 読み取り専用: バッチ4の準備。publicスキーマのテーブル・ビューのうち、anon / authenticated が
-- 実際に読めるもの(GRANTでSELECTを持ち、かつ「RLS無効」または「RLS有効でも読めるポリシーがある」)を
-- 全部洗い出す。2026-09-25 作成。JUNがSupabase SQL Editorで実行する(1ブロック=1回)。
--
-- 列の見方:
--   batch            : 既に対応済み/バッチ1〜3の対象か(対象外=バッチ4の候補)。バッチ3の一部は名前のパターンで判定。
--   anon_select / authenticated_select : has_table_privilege による実効のSELECT権限(PUBLICへのGRANT経由も含む)
--   rls              : RLSの有効/無効(ビューはnull。ビューは所有者権限で元テーブルを読むため、元テーブルのRLSが効かないことがある)
--   select_policies  : anon/authenticated/public に適用されるSELECT(またはALL)ポリシー名
--   readable_by_anon / readable_by_authenticated : 上記から判断した「実際に読めるか」
--   write_privs_anon : anonが持つ書き込み系権限(参考)
--   est_rows         : 行数の概算(pg_class.reltuples。-1は統計未取得)

-- 1) 実際に読めるものだけ(バッチ4の候補の確認用)
with rel as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity, c.reltuples
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
),
pol as (
  select tablename,
         string_agg(policyname || '(' || cmd || ':' || array_to_string(roles, '/') || ')', ', ' order by policyname) as names,
         bool_or(roles && array['anon', 'public']::name[]) as for_anon,
         bool_or(roles && array['authenticated', 'public']::name[]) as for_auth
  from pg_policies
  where schemaname = 'public' and cmd in ('SELECT', 'ALL') and permissive = 'PERMISSIVE'
  group by tablename
),
x as (
  select r.relname as table_name,
         case r.relkind when 'r' then 'table' when 'p' then 'table(partitioned)' when 'v' then 'view'
                        when 'm' then 'materialized view' when 'f' then 'foreign table' end as kind,
         case
           when r.relname in ('guide_bank_accounts', 'app_users', 'audit_logs', 'email_import_queue_archive',
                              'estimation_day_fixed_items') then '完了(A区分)'
           when r.relname in ('invoices', 'booking_costs', 'booking_sales', 'credit_card_statements') then 'バッチ1'
           when r.relname in ('business_partner_contacts', 'estimations', 'estimation_days', 'estimation_fixed_rows') then 'バッチ2(estimation_fixed_rowsは確認中)'
           when r.relname like 'arrangement\_document%' or r.relname like 'tour\_%'
             or r.relname in ('booking_guides', 'booking_water_items', 'bullet_train_arrangements',
                              'facility_operating_info', 'vendor_email_logs', 'error_logs') then 'バッチ3'
           else '対象外(バッチ4候補)'
         end as batch,
         has_table_privilege('anon', r.oid, 'SELECT') as anon_select,
         has_table_privilege('authenticated', r.oid, 'SELECT') as authenticated_select,
         case when r.relkind in ('r', 'p') then r.relrowsecurity end as rls,
         p.names as select_policies,
         has_table_privilege('anon', r.oid, 'SELECT')
           and (r.relkind not in ('r', 'p') or not r.relrowsecurity or coalesce(p.for_anon, false)) as readable_by_anon,
         has_table_privilege('authenticated', r.oid, 'SELECT')
           and (r.relkind not in ('r', 'p') or not r.relrowsecurity or coalesce(p.for_auth, false)) as readable_by_authenticated,
         concat_ws(', ',
           case when has_table_privilege('anon', r.oid, 'INSERT') then 'INSERT' end,
           case when has_table_privilege('anon', r.oid, 'UPDATE') then 'UPDATE' end,
           case when has_table_privilege('anon', r.oid, 'DELETE') then 'DELETE' end) as write_privs_anon,
         r.reltuples::bigint as est_rows
  from rel r
  left join pol p on p.tablename = r.relname
)
select *
from x
where readable_by_anon or readable_by_authenticated
order by (batch = '対象外(バッチ4候補)') desc, batch, table_name;

-- 2) 件数のまとめ(区分ごとに、読める/読めないの数)
with rel as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
),
pol as (
  select tablename, bool_or(roles && array['anon', 'public']::name[]) as for_anon
  from pg_policies
  where schemaname = 'public' and cmd in ('SELECT', 'ALL') and permissive = 'PERMISSIVE'
  group by tablename
)
select case when r.relkind in ('r', 'p') then 'table' else 'view等' end as kind,
       count(*) as total,
       count(*) filter (where has_table_privilege('anon', r.oid, 'SELECT')
                          and (r.relkind not in ('r', 'p') or not r.relrowsecurity or coalesce(p.for_anon, false))) as readable_by_anon
from rel r
left join pol p on p.tablename = r.relname
group by 1
order by 1;
