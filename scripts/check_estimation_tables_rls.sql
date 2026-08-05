-- F1事前調査: estimations関連5テーブルのRLS有効/無効・既存ポリシー内容を確認する
-- 読み取り専用SQL。変更は一切行わない。Supabaseダッシュボードの SQL Editor で実行すること。

-- 1) RLSの有効/無効(rowsecurity列がtrueなら有効)
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    'estimations',
    'estimation_days',
    'estimation_fixed_rows',
    'estimation_booking_reflections',
    'estimation_fit_items'
  )
order by tablename;

-- 2) 既存ポリシーの内容(RLSが有効な場合、どのロールに何を許可しているか)
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'estimations',
    'estimation_days',
    'estimation_fixed_rows',
    'estimation_booking_reflections',
    'estimation_fit_items'
  )
order by tablename, policyname;

-- 3) anon/authenticatedロールへのGRANT状況(RLSが無効でも、GRANT自体で
--    書き込みを許可/制限している場合があるため、他テーブルの移行時と同じ観点で確認する)
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'estimations',
    'estimation_days',
    'estimation_fixed_rows',
    'estimation_booking_reflections',
    'estimation_fit_items'
  )
  and grantee in ('anon', 'authenticated', 'service_role')
order by table_name, grantee, privilege_type;
