-- 読み取り専用: estimation_fixed_rows のRLS・GRANT・ポリシーの現状確認(バッチ2に含めるかの判断用)
-- 2026-09-25 作成。JUNがSupabase SQL Editorで1ブロックずつ実行する。

-- 1) RLSの有効/無効(rowsecurity=false なら、GRANTがある限りanonから読める)
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'estimation_fixed_rows';

-- 2) anon / authenticated / public に付いている権限(SELECTがあれば読める候補)
select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'estimation_fixed_rows'
  and grantee in ('anon', 'authenticated', 'PUBLIC')
group by grantee
order by grantee;

-- 3) ポリシー一覧(RLS有効の場合、anon/authenticated/public向けのSELECT/ALLポリシーがあれば読める)
select policyname, cmd, roles, permissive, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'estimation_fixed_rows'
order by policyname;
