-- 【2026-08-24 本番実行済み】selectを含む全面遮断版(記録用)。
--
-- 背景: app_users(ログイン情報)へのanon/authenticatedからの直接アクセスは、緊急パッチ
-- scripts/lock_down_app_users.sql(`revoke all`、selectも含めて全遮断)で既に対応済みだった。
-- 2026-08のシステム全体監査で、ログイン(/api/login)・パスワード変更(/api/change-password)・
-- ユーザー一覧取得(/api/list-users)・ユーザー追加/削除/パスワード再設定/権限変更
-- (/api/add-user)のいずれもservice_role key経由に完全移行済みで、フロントエンドから
-- sb.from('app_users')への直接参照が1件も残っていないことを再確認した上で、2026-08-24に
-- 本番DBへ改めてこのSQL(内容はscripts/lock_down_app_users.sqlと同一)を適用し、
-- select/insert/update/deleteの全権限がanon/authenticatedから剥奪済みであることを実機確認した。
--
-- scripts/lock_down_app_users.sqlを重複作成する形になるが、「いつ・どの調査を踏まえて
-- 本番適用したか」の記録を明確に残すため、実行日付入りの本ファイルを別途作成した
-- (内容の変更はしていない)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

-- ---- 実行前の確認(このSQLの本体を実行する前に、まず単独で実行して現状を確認すること) ----
-- 1) RLSの有効/無効(rowsecurityがtrueなら有効。今回はfalseのまま維持する)
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'app_users';

-- 2) anon/authenticated/service_roleへのGRANT状況
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'app_users'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- ---- 本体(selectを含む全権限をanon/authenticatedから剥奪する) ----
revoke all on public.app_users from anon, authenticated;

-- service_roleは/api/login等のサーバーレス関数(service_role key使用)が必要とするため、
-- 明示的に権限を残す。
grant select, insert, update, delete on public.app_users to service_role;

notify pgrst, 'reload schema';

-- ---- 実行後の確認(本体実行後、再度このクエリを流して意図通りになったか確認すること) ----
-- anon/authenticatedともに何も無し、service_roleは全権限、が期待値
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'app_users'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- ---- 切り戻し ----
-- 問題が起きた場合は、以下で元に戻せる(ただし本来のRLS/GRANT無効設計に戻すだけで、
-- 元々のログイン等の直接アクセスコード自体は既に削除済みのため、切り戻しても
-- フロントの動作は変わらない):
--   grant select, insert, update, delete on public.app_users to anon, authenticated;
--   notify pgrst, 'reload schema';
