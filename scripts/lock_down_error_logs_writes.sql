-- error_logs(全画面共通のエラー自動記録テーブル)を、危険な状態から締める。
--
-- 【2026-08-14点検で判明した実態】
-- ・RLS無効(relrowsecurity=false)
-- ・anonロールに SELECT/INSERT/UPDATE/DELETE/TRUNCATE の全権限が付与されたまま放置されていた
-- 公開anonキーを持つ第三者が、全ユーザーのエラーログ(ユーザーメール・エラーメッセージ・
-- スタックトレース最大8000文字・User-Agent)を自由に閲覧・改ざん・削除できる状態だった。
--
-- 【実行タイミング】
-- 必ず、コード側の切り替え(loadErrorLogs()をerrorLogsApiCall('list',...)経由=
-- /api/table-crud(service_role key)へ変更したコミット)を本番デプロイし、
-- admin@kictravel.jp / jr@kictravel.jpでログインして「🚨 エラーログ」画面が
-- 正常に表示されることを確認してから実行すること。
-- 先にこのSQLを実行すると、古いJSを開いたままのタブ(旧: sb.from('error_logs').select(...))
-- からのエラーログ閲覧が失敗する(email_import_queueロックダウン時と同じ注意点)。
--
-- 【このSQLで変わること】
-- ・anon/authenticated からの SELECT/UPDATE/DELETE/TRUNCATE を剥奪する
-- ・INSERT は anon に残す(index.htmlのlogError()が、ログイン前も含めアプリ全体の
--   エラーハンドラとして今も直接anonキーでINSERTしているため。authenticatedロールは
--   このアプリではSupabase Auth自体を使っておらず実際には使われていないが、他の
--   lock_down_*.sqlと同じく念のためSELECT/UPDATE/DELETE/TRUNCATEはこちらも剥奪する)
-- ・service_role は全権限を維持(/api/table-crudの新設list actionはこのキーで読み取る)
--
-- 【切り戻し】
-- 問題が起きた場合は、以下で元に戻せる:
--   grant select, update, delete, truncate on public.error_logs to anon, authenticated;
--   notify pgrst, 'reload schema';

-- ---- 実行前の確認(このSQLの本体を実行する前に、まず単独で実行して現状を確認すること) ----
-- 1) RLSの有効/無効(rowsecurityがtrueなら有効。今回はfalseのまま維持する)
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'error_logs';

-- 2) anon/authenticated/service_roleへのGRANT状況
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'error_logs'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- ---- 本体(上記の確認結果を見た上で実行すること) ----
revoke select, update, delete, truncate on public.error_logs from anon, authenticated;

grant insert on public.error_logs to anon;
grant select, insert, update, delete, truncate on public.error_logs to service_role;

notify pgrst, 'reload schema';

-- ---- 実行後の確認(本体実行後、再度このクエリを流して意図通りになったか確認すること) ----
-- anonは insert のみ、authenticatedは何も無し、service_roleは全権限、が期待値
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'error_logs'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;
