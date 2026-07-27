-- セキュリティ中長期対応 フェーズ1: local_expenses(現地費用明細/仮払い一覧表)への書き込みを
-- service_role経由に限定する。
--
-- 背景: booking_sales/booking_costs(scripts/lock_down_booking_sales_writes.sql、
-- lock_down_booking_costs_writes.sql参照)と同様、local_expensesもこれまで
-- anonキーからinsert/update/deleteが直接可能な状態だった。現地費用明細の保存処理を
-- /api/local-expenses(service_role key使用)経由に変更したため、anon/authenticatedロールからの
-- 直接書き込みを禁止する。
--
-- 読み取り(select)は今回変更しない。予約詳細モーダルの「仮払い一覧表」表示・PDF印刷等、
-- 既存の閲覧系機能は従来通りanonキー+RLSのまま動作する。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

revoke insert, update, delete on public.local_expenses from anon, authenticated;

-- service_roleは新設のAPI(/api/local-expenses、service_role key使用)が必要とするため、
-- 明示的に権限を残す(select含め、読み取り確認等でも使えるようにフルアクセスにしておく)。
grant select, insert, update, delete on public.local_expenses to service_role;

notify pgrst, 'reload schema';
