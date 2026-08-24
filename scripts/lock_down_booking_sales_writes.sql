-- 【2026-08-24 本番実行済み】
--
-- セキュリティ中長期対応 フェーズ1: booking_sales(売上明細)への書き込みをservice_role経由に限定する。
--
-- 背景: app_users(scripts/lock_down_app_users.sql参照)と同様、booking_salesもこれまで
-- anonキーからinsert/update/deleteが直接可能な状態だった。売上明細の保存処理を
-- /api/booking-sales(service_role key使用)経由に変更したため、anon/authenticatedロールからの
-- 直接書き込みを禁止する。
--
-- 読み取り(select)は今回変更しない。一覧表示・集計・PDF出力等、既存の閲覧系機能は
-- 従来通りanonキー+RLSのまま動作する。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

revoke insert, update, delete on public.booking_sales from anon, authenticated;

-- service_roleは新設のAPI(/api/booking-sales、service_role key使用)が必要とするため、
-- 明示的に権限を残す(select含め、読み取り確認等でも使えるようにフルアクセスにしておく)。
grant select, insert, update, delete on public.booking_sales to service_role;

notify pgrst, 'reload schema';
