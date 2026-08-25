-- 緊急調査用: bullet_train_arrangements(新幹線手配)の既存データが本番の予約詳細画面
-- 「新幹線」タブに表示されない不具合の切り分け用SQL。
--
-- 仮説: lock_down_tour_arrangements_writes.sqlの
--   drop policy if exists "anon全権限" on public.bullet_train_arrangements;
-- を本番実行した際、bullet_train_arrangementsはRLS(rowsecurity)が有効(true)で、
-- 「anon全権限」が唯一のanon許可ポリシーだった場合、そのポリシーをDROPすると
-- anonに対する許可ポリシーが0件になり、GRANT自体(select権限)は残っていても
-- RLSが「該当ポリシー無し=deny」としてSELECTの結果を常に0行にしてしまう
-- (エラーにはならず、単に空配列が返る。「明細なし」表示と一致する)。
-- コード側(index.html/api/table-crud.js)はこのタブの読み込みSELECT文を一切変更して
-- いないため、コードの不具合であればPR #80/#81時点の差分に現れるはずだが、
-- 実際には読み込み処理(sb.from('bullet_train_arrangements').select(...))に変更は無い
-- (index.html 7788行目、diffなし)。DB側の状態変化を最優先で疑うべき状況。

-- 1) RLSが有効かどうか(true = 有効)
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename = 'bullet_train_arrangements';

-- 2) 現在のポリシー一覧(「anon全権限」が本当に消えているか、anonを許可する他のポリシーが
--    残っているかを確認)
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'bullet_train_arrangements'
order by policyname;

-- 3) anon/service_roleのGRANT状況(SELECTがまだ付与されているか。ここが原因ならSELECTは
--    付与されたままのはず)
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'bullet_train_arrangements'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- 4) 実データの存在確認(予約#1068。DB上に2行存在することは確認済みとのことだが、
--    念のため再掲)
select id, booking_ref, ride_date, train_name, train_number, sort_order
from public.bullet_train_arrangements
where booking_ref = '#1068'
order by sort_order;

-- ---- 上記1)がtrue(RLS有効)かつ2)にanonを許可するポリシーが1件も無い場合、
--      これが原因である可能性が高い。以下のいずれかで復旧する ----

-- 対応A(推奨): このアプリの他の運用テーブルと同じ方式(RLS無効化+GRANTのみで制御)に
-- 合わせる。tour_arrangements/tour_arrangement_days/arrangement_documentsを含む
-- ほぼ全テーブルがこの方式(CLAUDE.md記載のアプリ設計方針: Supabase Authを使わず
-- 独自のapp_usersでログイン管理しており、RLSは無効化してGRANT/REVOKEのみで
-- 書き込み範囲を制御する)。
-- alter table public.bullet_train_arrangements disable row level security;

-- 対応B: RLSを有効のまま維持したい場合は、anonにSELECTを許可するポリシーを
-- 再作成する(書き込み系(insert/update/delete)は許可しない。GRANT側で既に
-- anon/authenticatedのinsert/update/deleteは剥奪済みのため、SELECT用の
-- permissiveポリシーのみで十分)。
-- create policy "anon_select" on public.bullet_train_arrangements
--   for select to anon, authenticated using (true);

-- 実行後、上記4)を再実行し、booking_ref='#1068'の2行が返ってくることを確認すること。
-- 併せて、予約詳細画面の「新幹線」タブ、サイドバー「新幹線手配」一覧の両方で、
-- 他の予約のデータも含めて表示が復旧していることを確認すること(横展開確認)。

notify pgrst, 'reload schema';
