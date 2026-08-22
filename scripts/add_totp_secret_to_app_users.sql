-- admin@kictravel.jp用の2段階認証(TOTP)のため、app_usersにtotp_secret列を追加する。
--
-- app_usersはscripts/lock_down_app_users.sqlにより既にanon/authenticatedからの直接アクセスを
-- 全権限revokeしており、service_role(サーバー側API経由)からしかアクセスできない状態のため、
-- この列も追加のRLS/GRANTを行わなくても既存の権限構成のままanon/authenticatedからは読めない。
-- (/api/login, /api/totp-setup がservice_role keyでのみ読み書きする)
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.app_users
  add column if not exists totp_secret text;

notify pgrst, 'reload schema';
