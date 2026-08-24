-- 【2026-08-24 本番実行済み】selectを含む全面遮断版(記録用)。
--
-- 背景: guide_bank_accounts(ガイド口座情報)は新設テーブルのため、設計時から
-- anon/authenticatedへのGRANTは一切行わず、最初からservice_role経由のみで運用する方針
-- だった(api/table-crud.jsのTABLE_CONFIG.guide_bank_accountsのコメント参照。
-- insert/updateById/deleteById/listByFieldのみを許可し、SELECTすら解放していない
-- ―― 出金伝票への自動反映用にguide_id検索専用のlistByFieldアクションのみ許可)。
-- フロントエンド(index.html・guide.html)にはsb.from('guide_bank_accounts')の直接参照が
-- 1件も存在しないことを2026-08のシステム全体監査で確認済み。
--
-- 今回のREVOKEは、設計通りGRANTが一切されていないことを本番DBで明示的に確認・保証する
-- ための念のための実行(冪等)であり、本SQLの実行前後でアプリの挙動に変化は無い想定。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

-- ---- 実行前の確認(このSQLの本体を実行する前に、まず単独で実行して現状を確認すること) ----
-- 1) RLSの有効/無効
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'guide_bank_accounts';

-- 2) anon/authenticated/service_roleへのGRANT状況(設計上、anon/authenticatedには
--    何も表示されないはず)
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'guide_bank_accounts'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- ---- 本体(selectを含む全権限をanon/authenticatedから確実に剥奪する) ----
revoke all on public.guide_bank_accounts from anon, authenticated;

-- service_roleはapi/table-crud.js(service_role key使用)が必要とするため、
-- 明示的に権限を残す。
grant select, insert, update, delete on public.guide_bank_accounts to service_role;

notify pgrst, 'reload schema';

-- ---- 実行後の確認(本体実行後、再度このクエリを流して意図通りになったか確認すること) ----
-- anon/authenticatedともに何も無し、service_roleは全権限、が期待値
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'guide_bank_accounts'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- ---- 切り戻し ----
-- 設計上、切り戻しは想定していない(元々anon/authenticatedへのGRANTが無い状態が正)。
-- 万一必要になった場合のみ、以下で戻せる:
--   grant select, insert, update, delete on public.guide_bank_accounts to anon, authenticated;
--   notify pgrst, 'reload schema';
