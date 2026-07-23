-- セキュリティ中長期対応 フェーズ1: booking_costs(仕入明細)への書き込みをservice_role経由に限定する。
--
-- 背景: booking_sales(scripts/lock_down_booking_sales_writes.sql参照)と同様、booking_costsも
-- これまでanonキーからinsert/update/deleteが直接可能な状態だった。仕入明細の保存処理を
-- /api/booking-costs(service_role key使用)経由に変更したため、anon/authenticatedロールからの
-- 直接書き込みを禁止する。
--
-- 読み取り(select)は今回変更しない。一覧表示・集計・PDF出力等、既存の閲覧系機能は
-- 従来通りanonキー+RLSのまま動作する。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

revoke insert, update, delete on public.booking_costs from anon, authenticated;

-- service_roleは新設のAPI(/api/booking-costs、service_role key使用)が必要とするため、
-- 明示的に権限を残す(select含め、読み取り確認等でも使えるようにフルアクセスにしておく)。
grant select, insert, update, delete on public.booking_costs to service_role;

notify pgrst, 'reload schema';
