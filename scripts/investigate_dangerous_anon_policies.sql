-- 読み取り専用: publicスキーマの全テーブルで、anon/publicに無条件(qual=true)の書き込み系
-- (ALL/INSERT/UPDATE/DELETE)を許可しているポリシーを洗い出す(estimation_fixed_rowsの
-- "Allow anon full access..."と同種のものが他に無いかの確認。2026-09-29 JUN指示)。
-- Supabaseダッシュボードの SQL Editor で実行する。
--
-- 【注記】pg_policiesにはポリシーの作成日時・作成者は記録されない(PostgreSQLの仕様。
-- 監査ログの対象外)。「いつ・誰が作ったか」はこのSQLでは分からないため、Supabase
-- ダッシュボードの Database > Migrations(またはプロジェクトのAPIログ/Support)を
-- 別途確認する必要がある。このリポジトリのscripts/配下にも同名ポリシーを作成する
-- 記述は無い(grep確認済み)ため、少なくともこのプロジェクトのSQLファイル経由では
-- 作られていない。

-- 1) 危険度の高いもの(anon/publicに、無条件のALL/INSERT/UPDATE/DELETEを許可)を優先表示
select
  p.tablename,
  p.policyname,
  p.permissive,
  p.roles,
  p.cmd,
  p.qual,
  p.with_check,
  pt.rowsecurity,
  (p.qual::text = 'true' or p.qual is null) as using_unconditional,
  (p.with_check::text = 'true' or (p.cmd in ('INSERT','ALL') and p.with_check is null)) as check_unconditional
from pg_policies p
join pg_tables pt on pt.schemaname = p.schemaname and pt.tablename = p.tablename
where p.schemaname = 'public'
  and p.permissive = 'PERMISSIVE'
  and p.roles && array['anon', 'public']::name[]
  and p.cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
order by using_unconditional desc, p.tablename, p.cmd;

-- 2) 参考: anon/publicのSELECTポリシー一覧(書き込みは無いが読み取りを許可しているもの。
--    バッチ4の洗い出し(investigate_batch4_readable_tables.sql)と重複する内容だが、
--    ポリシーの中身(qual)まで見るのはこちらが詳しい)
select p.tablename, p.policyname, p.roles, p.qual, pt.rowsecurity
from pg_policies p
join pg_tables pt on pt.schemaname = p.schemaname and pt.tablename = p.tablename
where p.schemaname = 'public'
  and p.permissive = 'PERMISSIVE'
  and p.roles && array['anon', 'public']::name[]
  and p.cmd in ('SELECT', 'ALL')
order by p.tablename, p.policyname;

-- 3) RLSが有効なのにポリシーが1件も無いテーブル(anon/authenticatedは全面アクセス不可のはずだが、
--    「有効化したつもりで実は緩いポリシーが残っている」の逆、つまり正しく閉じられているか確認用の参考)
select pt.tablename
from pg_tables pt
where pt.schemaname = 'public' and pt.rowsecurity = true
  and not exists (select 1 from pg_policies p where p.schemaname = pt.schemaname and p.tablename = pt.tablename)
order by pt.tablename;
