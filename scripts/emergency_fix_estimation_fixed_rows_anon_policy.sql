-- 緊急対応: estimation_fixed_rows に付いていた "Allow anon full access to estimation_fixed_rows"
-- (ALL, roles={anon}, qual=true, with_check=true)を取り除く。このポリシーはRLS(rowsecurity=true)を
-- 実質無効化しており、anonがこのテーブルの行を自由に読み書き削除できる状態だった(2026-09-29 JUN報告)。
--
-- 方針(JUN判断待ちの点への回答): READ側のAPI移行(バッチ2)がまだデプロイされていない今、ポリシーを
-- 単純に削除する(RLS有効+ポリシー0件)と、既存の3画面(見積もりコピー・アーカイブ・年度アーカイブの
-- estimation_fixed_rows直接SELECT)がその場で読めなくなる。二重の被害(書き込み放置のまま/読み取り停止)を
-- 避けるため、次の2つを同時に行う:
--   (a) 書き込み系(INSERT/UPDATE/DELETE/TRUNCATE)およびREFERENCES/TRIGGERの権限をanon/authenticatedから
--       GRANTレベルでREVOKEする(facility_operating_info・B/C区分全テーブルの時と同じ手順)。
--       RLSポリシーの中身に関わらず、権限が無ければ実行できない。
--   (b) 問題のALLポリシーをSELECT専用の新しいポリシーに置き換える(既存の3画面の読み取りは維持する)。
-- これにより、二重払い調査の時と同様「今すぐ書き込みの穴を塞ぐが、今動いている読み取り機能は止めない」
-- 状態にする。バッチ2のコードがデプロイ・確認され次第、このSELECTポリシーとSELECTのGRANTも
-- 別途REVOKEする(通常のバッチと同じ最終形: ブラウザ直接アクセス0、service_role API経由のみ。
-- STEP 5参照: そのREVOKEはscripts/enable_rls_batch2.sql(バッチ2のRLS有効化SQL、これから作成)の
-- 中に含める。このファイル単体では実行しない)。
--
-- 【JUN実行結果・追記】GRANT(STEP 0-3)の結果: anon/authenticatedともにREFERENCES, SELECT, TRIGGER,
-- TRUNCATE(INSERT/UPDATE/DELETEは無し)。TRUNCATE権限はRLSポリシーの内容に関わらずテーブル全体を
-- 削除できてしまうため、(a)に含めていたTRUNCATEのREVOKEが実質最大の脅威への対処だった。
-- REFERENCES/TRIGGERも合わせてREVOKEする(下記STEP 3(a)に追加。既存のB/C区分と同じ扱いに揃える)。
--
-- CLAUDE.mdの「RLSポリシー削除・REVOKE作業の手順」に従い、削除前に現状を確認し、削除後に
-- 許可ポリシーが意図しない0件(全面アクセス不可)にならないことをSTEP 2でシミュレーションしてから
-- STEP 3で実行する。データの行は一切変更しない(DDLのみ)。
-- Supabaseダッシュボードの SQL Editor で、STEPごとに1回ずつ実行すること。

-- ===== STEP 0: 現状の確認(読み取り専用) =====
-- 0-1. RLSの有効/無効
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'estimation_fixed_rows';

-- 0-2. 現在のポリシー(問題の"Allow anon full access..."が1件のはず)
select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'estimation_fixed_rows'
order by policyname;

-- 0-3. 現在のGRANT(anon/authenticatedが実際に持っている権限。書き込み権限が付いているかがここで分かる)
select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'estimation_fixed_rows'
  and grantee in ('anon', 'authenticated', 'PUBLIC')
group by grantee
order by grantee;

-- ===== STEP 1: 現在この画面が実際に使っている読み取りパターン(参考・読み取り専用) =====
-- index.html側の直接SELECTは3箇所とも estimation_id の in(...) 絞り込みのみ(exportBookingArchive /
-- exportFiscalYearArchive / openEstimationEditor)。書き込み(insert/update/delete)は無い
-- (grep確認済み。すべてservice_role経由のreplaceByKeyのみ)。よってSTEP 3(b)のSELECT限定ポリシーで
-- 現状の読み取り機能は維持できる。

-- ===== STEP 2: 削除後のシミュレーション(読み取り専用) =====
-- 実行後、n_permissive_for_anon_after が 0 になる(=SELECTを含め全面アクセス不可になる)ことを確認する。
-- 【重要】ここで0になることは、STEP 3(b)で新しいSELECTポリシーを同時に作るため想定どおり。
-- もしSTEP 3(b)を行わずにポリシー削除だけで終える場合は、この0件が「読み取りも止まる」ことを意味する。
select count(*) as n_permissive_for_anon_after
from pg_policies
where schemaname = 'public' and tablename = 'estimation_fixed_rows'
  and policyname <> 'Allow anon full access to estimation_fixed_rows'
  and permissive = 'PERMISSIVE'
  and roles && array['anon', 'public']::name[];

-- ===== STEP 3: 実行 =====
-- (a) 書き込み系・REFERENCES・TRIGGERの権限をGRANTレベルで剥奪する(既に権限が無い項目があっても
--     REVOKEはエラーにならない=安全に実行できる)。
revoke insert, update, delete, truncate, references, trigger on public.estimation_fixed_rows from anon, authenticated;

-- (b) 危険なALLポリシーを、読み取り専用の新しいポリシーに置き換える。
drop policy if exists "Allow anon full access to estimation_fixed_rows" on public.estimation_fixed_rows;

drop policy if exists estimation_fixed_rows_temp_read_only on public.estimation_fixed_rows;
create policy estimation_fixed_rows_temp_read_only
  on public.estimation_fixed_rows
  for select
  to anon, authenticated
  using (true);
comment on policy estimation_fixed_rows_temp_read_only on public.estimation_fixed_rows is
  '2026-09-29緊急対応の暫定措置。バッチ2(API経由化)デプロイ・確認後に削除すること。';

notify pgrst, 'reload schema';

-- ===== STEP 4: 確認(読み取り専用) =====
-- 期待: ポリシーは estimation_fixed_rows_temp_read_only(SELECT)のみ。
--       anon/authenticatedの権限はSELECTのみ(INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGERなし)。
select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'estimation_fixed_rows'
order by policyname;

select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'estimation_fixed_rows'
  and grantee in ('anon', 'authenticated', 'PUBLIC')
group by grantee
order by grantee;

select has_table_privilege('anon', 'public.estimation_fixed_rows', 'INSERT') as anon_can_insert,
       has_table_privilege('anon', 'public.estimation_fixed_rows', 'UPDATE') as anon_can_update,
       has_table_privilege('anon', 'public.estimation_fixed_rows', 'DELETE') as anon_can_delete,
       has_table_privilege('anon', 'public.estimation_fixed_rows', 'TRUNCATE') as anon_can_truncate,
       has_table_privilege('anon', 'public.estimation_fixed_rows', 'REFERENCES') as anon_can_references,
       has_table_privilege('anon', 'public.estimation_fixed_rows', 'TRIGGER') as anon_can_trigger,
       has_table_privilege('anon', 'public.estimation_fixed_rows', 'SELECT') as anon_can_select;

-- ===== STEP 5 =====
-- この暫定ポリシー(estimation_fixed_rows_temp_read_only)とSELECTのGRANTの削除は、このファイルでは
-- 実行しない。バッチ2のコードがデプロイ・確認された後、scripts/enable_rls_batch2.sql(バッチ2の
-- RLS有効化・REVOKE本体。business_partner_contacts/estimations/estimation_days/estimation_fixed_rowsの
-- RLS有効化+GRANT REVOKE、search_business_partners RPCのEXECUTE REVOKEをまとめたもの)の中に、
-- 次の内容を含めて実行する(2026-09-29 JUN指示):
--   drop policy if exists estimation_fixed_rows_temp_read_only on public.estimation_fixed_rows;
--   revoke select on public.estimation_fixed_rows from anon, authenticated;
