-- 緊急パッチ: app_users(ログイン情報)へのanon/authenticatedからの直接アクセスを遮断する。
--
-- 背景: これまでapp_usersは他の運用テーブルと同様、anonキーからselect/insert/update/delete
-- が可能な状態だった。ログイン処理自体がクライアント側からanonキーで直接
-- app_users.select().eq('password', pw) のように照合していたため、ブラウザの開発者ツール等から
-- anonキーで直接叩けば、ログインを経由せず全ユーザーの(当時は平文だった)パスワードを含む
-- レコードを閲覧・改ざんできる状態だった。
--
-- 対応: ログイン/パスワード変更/ユーザー一覧取得/ユーザー追加を、すべてservice_role keyを
-- 使うサーバーレス関数(/api/login, /api/change-password, /api/list-users, /api/add-user)経由に
-- 変更したため、anon/authenticatedロールからのapp_users直接アクセスを完全に遮断する。
-- (パスワードのbcryptハッシュ化は各APIのコード側で行う。既存の平文パスワードは
--  次回ログイン成功時に自動でハッシュ化される。一括移行スクリプトは不要)
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

revoke all on public.app_users from anon, authenticated;

-- service_roleは新設のAPI(service_role key使用)が必要とするため、明示的に権限を残す。
grant select, insert, update, delete on public.app_users to service_role;

notify pgrst, 'reload schema';
