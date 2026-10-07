-- RLS対応フェーズ2 バッチ2: business_partner_contacts / estimations / estimation_days の
-- RLS有効化(ポリシーなし)+ anon/authenticatedのGRANT全REVOKE +
-- RPC search_business_partners の EXECUTE REVOKE。
--
-- 前提: ブラウザ(index.html)からこの3テーブルへの直接SELECT・search_business_partners の直接RPC呼び出しを
-- 0件にし、ログイン検証つきAPI(/api/table-crud の query/queryBatch/rpc、service_role)経由に統一した
-- コードが本番にデプロイ済みであること。書き込みは既に全てAPI経由。
-- service_roleはRLSをバイパスするため、ポリシーは作らない。
--
-- 【実行タイミング(順序厳守。CLAUDE.md「RLSポリシー削除・REVOKE作業の手順」)】
--   コードをデプロイ → JUNが本番で実機確認 → このSQLを実行 → 再度実機確認。
--   実行後は、開いているタブはハードリロード(Ctrl+Shift+R)すること。
-- Supabase SQL Editorで、STEPごとに(1ブロックずつ)実行する。切り戻しは末尾のROLLBACK用。

-- ============================================================
-- STEP1: 実行前の確認(読み取りのみ。1ブロックずつ実行)
-- ============================================================
-- 1-1) RLSの有効/無効(期待: 3テーブルとも rowsecurity = false)
select tablename, rowsecurity from pg_tables
where schemaname='public' and tablename in ('business_partner_contacts','estimations','estimation_days')
order by tablename;

-- 1-2) 既存ポリシー(期待: 0件。あればRLS有効化後もanonから読めてしまうため内容を確認する)
select tablename, policyname, roles, cmd, qual from pg_policies
where schemaname='public' and tablename in ('business_partner_contacts','estimations','estimation_days')
order by tablename, policyname;

-- 1-3) 現在のGRANT(期待: anon/authenticatedはSELECTのみ)
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema='public' and table_name in ('business_partner_contacts','estimations','estimation_days')
  and grantee in ('anon','authenticated','service_role','PUBLIC')
group by table_name, grantee order by table_name, grantee;

-- 1-4) この3テーブルを本文で参照する他の関数・ビュー(期待: search_business_partners 以外は0件。
--      他にあれば、ブラウザ(anon)から呼ばれていないか確認してから実行する)
select 'function' as kind, p.proname as name, p.prosecdef
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prosrc ~ '(business_partner_contacts|estimations|estimation_days)'
  and p.proname <> 'search_business_partners'
union all
select 'view', v.viewname, null from pg_views v
where v.schemaname='public' and v.definition ~ '(business_partner_contacts|estimations|estimation_days)'
order by 1, 2;

-- ============================================================
-- STEP2: 本体(1トランザクション)。STEP1を確認し、本番で実機確認が終わってから実行する。
-- ============================================================
begin;

grant select, insert, update, delete on public.business_partner_contacts to service_role;
grant select, insert, update, delete on public.estimations to service_role;
grant select, insert, update, delete on public.estimation_days to service_role;

alter table public.business_partner_contacts enable row level security;
alter table public.estimations enable row level security;
alter table public.estimation_days enable row level security;

revoke all on public.business_partner_contacts from anon, authenticated;
revoke all on public.estimations from anon, authenticated;
revoke all on public.estimation_days from anon, authenticated;

grant execute on function public.search_business_partners(text, text) to service_role;
revoke execute on function public.search_business_partners(text, text) from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';

-- ============================================================
-- STEP3: 実行後の確認(1ブロックずつ)
-- ============================================================
-- 3-1) 期待: 3テーブルとも rowsecurity = true、anon_select = false、authenticated_select = false
select t.tablename, t.rowsecurity,
       has_table_privilege('anon', format('public.%I', t.tablename), 'SELECT') as anon_select,
       has_table_privilege('authenticated', format('public.%I', t.tablename), 'SELECT') as authenticated_select
from pg_tables t
where t.schemaname='public' and t.tablename in ('business_partner_contacts','estimations','estimation_days')
order by t.tablename;

-- 3-2) 期待: anon_exec = false, authenticated_exec = false, service_role_exec = true
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_exec
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='search_business_partners';

-- ============================================================
-- ROLLBACK用(問題が出た場合のみ。実行前の状態=anon/authenticatedにSELECTのみ、RLS無効、RPCはEXECUTE可)
-- ============================================================
-- begin;
-- grant select on public.business_partner_contacts, public.estimations, public.estimation_days to anon, authenticated;
-- alter table public.business_partner_contacts disable row level security;
-- alter table public.estimations disable row level security;
-- alter table public.estimation_days disable row level security;
-- grant execute on function public.search_business_partners(text, text) to anon, authenticated;
-- commit;
-- notify pgrst, 'reload schema';
