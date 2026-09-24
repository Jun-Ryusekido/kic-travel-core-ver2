-- RLS対応フェーズ2 バッチ1: invoices / booking_costs / booking_sales / credit_card_statements の
-- RLS有効化(ポリシーなし)+ anon/authenticatedの残りGRANTの全REVOKE +
-- 入出金RPC 3本(get_payment_monthly_summary / search_payment_income / search_payment_outflow)の
-- EXECUTE REVOKE。
--
-- 前提: ブラウザ(index.html)からこの4テーブルへの直接SELECT・RPC 3本の直接呼び出しを0件にし、
-- ログイン検証つきAPI(/api/table-crud の query/queryBatch/rpc、service_role)経由に統一したコードが
-- 本番にデプロイ済みであること。書き込みは既に全てAPI経由(scripts/lock_down_*_writes.sql 実行済み)。
-- service_roleはRLSをバイパスするため、ポリシーは作らない(anon向けSELECTポリシー案は不採用。
-- SESSION_NOTES.md 参照)。
--
-- 【実行タイミング(順序厳守。CLAUDE.md「RLSポリシー削除・REVOKE作業の手順」)】
--   コードをデプロイ → JUNが本番で実機確認(チェックリスト) → このSQLを実行 → 再度実機確認。
--   先に実行すると、古いJSを開いたままのタブ・未デプロイの状態で読み取りが全て0件/エラーになる。
--   実行後は、開いているタブはハードリロードすること。
--
-- Supabaseダッシュボードの SQL Editor で、STEPごとに実行すること。
-- 切り戻し(問題が出た場合): 末尾の「ROLLBACK用」を実行する。

-- ============================================================
-- STEP1: 実行前の確認(読み取りのみ)
-- ============================================================
-- 1-1) RLSの有効/無効(期待: 4テーブルとも rowsecurity = false)
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('invoices', 'booking_costs', 'booking_sales', 'credit_card_statements')
order by tablename;

-- 1-2) 既存のRLSポリシー(期待: 0件。1件でもあれば実行前に内容を確認する。
--      RLS有効化後に許可ポリシーが残っていると、anonから読めるままになる)
select tablename, policyname, roles, cmd, qual
from pg_policies
where schemaname = 'public'
  and tablename in ('invoices', 'booking_costs', 'booking_sales', 'credit_card_statements')
order by tablename, policyname;

-- 1-3) 現在のGRANT(期待: anon/authenticatedはSELECTのみ。service_roleはSELECT/INSERT/UPDATE/DELETE)
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('invoices', 'booking_costs', 'booking_sales', 'credit_card_statements')
  and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
group by table_name, grantee
order by table_name, grantee;

-- 1-4) RPC 3本のEXECUTE権限と種別(期待: prosecdef = false(SECURITY INVOKER)。
--      anon/authenticated/public(=PUBLIC)にEXECUTEあり)
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_exec,
       p.proacl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_payment_monthly_summary', 'search_payment_income', 'search_payment_outflow')
order by p.proname;

-- 1-5) この4テーブルを本文で参照している他の関数・ビュー(期待: 上記RPC 3本以外は0件。
--      他にあれば、それがブラウザ(anon)から呼ばれていないか確認してから実行する。
--      SECURITY INVOKERの関数・ビューはRLS有効化後、anonからは0件しか返さなくなる)
select 'function' as kind, p.proname as name, p.prosecdef
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosrc ~ '(booking_sales|booking_costs|invoices|credit_card_statements)'
  and p.proname not in ('get_payment_monthly_summary', 'search_payment_income', 'search_payment_outflow')
union all
select 'view', v.viewname, null
from pg_views v
where v.schemaname = 'public'
  and v.definition ~ '(booking_sales|booking_costs|invoices|credit_card_statements)'
order by 1, 2;

-- ============================================================
-- STEP2: 本体(1トランザクション)。STEP1の結果を確認し、実機確認が終わってから実行する。
-- ============================================================
begin;

-- service_role(API)の権限を明示的に保証する(既に付与済みでも無害)
grant select, insert, update, delete on public.invoices to service_role;
grant select, insert, update, delete on public.booking_costs to service_role;
grant select, insert, update, delete on public.booking_sales to service_role;
grant select, insert, update, delete on public.credit_card_statements to service_role;

-- RLS有効化(ポリシーは作らない。service_roleはRLSをバイパスする)
alter table public.invoices enable row level security;
alter table public.booking_costs enable row level security;
alter table public.booking_sales enable row level security;
alter table public.credit_card_statements enable row level security;

-- anon/authenticatedの残りGRANT(SELECT等)を全てREVOKE
revoke all on public.invoices from anon, authenticated;
revoke all on public.booking_costs from anon, authenticated;
revoke all on public.booking_sales from anon, authenticated;
revoke all on public.credit_card_statements from anon, authenticated;

-- RPC 3本: service_roleのEXECUTEを保証してから、public/anon/authenticatedのEXECUTEをREVOKE
-- (関数は作成時に既定でPUBLICへEXECUTEが付くため、publicからのREVOKEも必須)
grant execute on function public.get_payment_monthly_summary(date, date) to service_role;
grant execute on function public.search_payment_income(date, date, text) to service_role;
grant execute on function public.search_payment_outflow(date, date, text) to service_role;
revoke execute on function public.get_payment_monthly_summary(date, date) from public, anon, authenticated;
revoke execute on function public.search_payment_income(date, date, text) from public, anon, authenticated;
revoke execute on function public.search_payment_outflow(date, date, text) from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';

-- ============================================================
-- STEP3: 実行後の確認
-- ============================================================
-- 3-1) 期待: 4テーブルとも rowsecurity = true
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('invoices', 'booking_costs', 'booking_sales', 'credit_card_statements')
order by tablename;

-- 3-2) 期待: service_roleの行だけ(DELETE,INSERT,SELECT,UPDATE)。anon/authenticatedの行が0件
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('invoices', 'booking_costs', 'booking_sales', 'credit_card_statements')
  and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
group by table_name, grantee
order by table_name, grantee;

-- 3-3) 期待: anon_exec = false, authenticated_exec = false, service_role_exec = true
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_payment_monthly_summary', 'search_payment_income', 'search_payment_outflow')
order by p.proname;

-- 3-4) 期待: 4テーブルとも anon_select = false
select t.tablename,
       has_table_privilege('anon', format('public.%I', t.tablename), 'SELECT') as anon_select,
       has_table_privilege('authenticated', format('public.%I', t.tablename), 'SELECT') as authenticated_select
from pg_tables t
where t.schemaname = 'public'
  and t.tablename in ('invoices', 'booking_costs', 'booking_sales', 'credit_card_statements')
order by t.tablename;

-- ============================================================
-- ROLLBACK用(問題が出た場合のみ。実行前の状態=anon/authenticatedにSELECTのみ、RLS無効、RPCはEXECUTE可 に戻す)
-- ============================================================
-- begin;
-- grant select on public.invoices, public.booking_costs, public.booking_sales, public.credit_card_statements to anon, authenticated;
-- alter table public.invoices disable row level security;
-- alter table public.booking_costs disable row level security;
-- alter table public.booking_sales disable row level security;
-- alter table public.credit_card_statements disable row level security;
-- grant execute on function public.get_payment_monthly_summary(date, date) to anon, authenticated;
-- grant execute on function public.search_payment_income(date, date, text) to anon, authenticated;
-- grant execute on function public.search_payment_outflow(date, date, text) to anon, authenticated;
-- commit;
-- notify pgrst, 'reload schema';
