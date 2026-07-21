-- 緊急ロールバック: ログイン不能障害の復旧用。
--
-- 直前のセキュリティパッチ(service_role経由のログインAPI化)で本番ログインが
-- 全ユーザーで失敗する障害が発生したため、アプリ側のログイン/パスワード変更/
-- ユーザー管理機能を、anonキーで直接app_usersを操作する従来方式へ緊急で戻した。
-- これに伴い、直前に実行した lock_down_app_users.sql で剥奪した
-- anon/authenticatedのapp_usersへの直接アクセス権限を再度付与する。
--
-- 注意: これによりapp_usersはセキュリティパッチ導入前と同じ状態(anonキーで
-- 直接select/insert/update/delete可能)に戻る。ログイン復旧後、原因調査の上で
-- 改めて安全な形でのセキュリティ強化を検討すること。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

grant select, insert, update, delete on public.app_users to anon, authenticated;

notify pgrst, 'reload schema';
