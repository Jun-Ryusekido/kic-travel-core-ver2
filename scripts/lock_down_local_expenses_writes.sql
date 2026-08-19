-- セキュリティ中長期対応 フェーズ1: local_expenses(現地費用明細/仮払い一覧表)への書き込みを
-- service_role経由に限定する。
--
-- 背景: booking_sales/booking_costs(scripts/lock_down_booking_sales_writes.sql、
-- lock_down_booking_costs_writes.sql参照)と同様、local_expensesもこれまで
-- anonキーからinsert/update/deleteが直接可能な状態だった。書き込み経路のうち
-- saveLocalExpenses()(予約詳細の仮払い一覧表エディタ、localExpensesApiCall('replace',...))と
-- 予約削除処理(localExpensesApiCall('deleteByBooking',...))は既に/api/table-crud
-- (service_role key使用)経由に移行済みだったが、saveInvoiceConfirm()(請求書AI読み取り→
-- 仮払いインポートの💾保存ボタン)だけがanonキーでの直接insertのまま取り残されていた
-- (2026-08-19点検で発見)。これをlocalExpensesApiCall('insert',...)経由に切り替えるコード
-- 修正と合わせて、anon/authenticatedロールからの直接書き込みを禁止する。
--
-- 読み取り(select)は今回変更しない。予約詳細モーダルの「仮払い一覧表」表示・PDF印刷等、
-- 既存の閲覧系機能は従来通りanonキー+RLSのまま動作する。
--
-- 【実行タイミング】
-- 必ず、コード側の切り替え(saveInvoiceConfirm()をlocalExpensesApiCall('insert',...)経由に
-- 変更したコミット、api/table-crud.jsのlocal_expensesにinsertアクションを追加したコミット)を
-- 本番デプロイし、実際に請求書AI読み取り→仮払いインポートの💾保存ボタンが正常に動作する
-- ことを確認してから実行すること(error_logsロックダウン時と同じ注意点。先にこのSQLを
-- 実行すると、古いJSを開いたままのタブからの保存が失敗する)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

-- ---- 実行前の確認(このSQLの本体を実行する前に、まず単独で実行して現状を確認すること) ----
-- 1) RLSの有効/無効(rowsecurityがtrueなら有効。今回はfalseのまま維持する)
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'local_expenses';

-- 2) anon/authenticated/service_roleへのGRANT状況
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'local_expenses'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- ---- 本体(上記の確認結果を見た上で、コードデプロイ・動作確認後に実行すること) ----
revoke insert, update, delete on public.local_expenses from anon, authenticated;

-- service_roleは/api/table-crud(service_role key使用)が必要とするため、
-- 明示的に権限を残す(select含め、読み取り確認等でも使えるようにフルアクセスにしておく)。
grant select, insert, update, delete on public.local_expenses to service_role;

notify pgrst, 'reload schema';

-- ---- 実行後の確認(本体実行後、再度このクエリを流して意図通りになったか確認すること) ----
-- anonはselectのみ、authenticatedは何も無し、service_roleは全権限、が期待値
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'local_expenses'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- ---- 切り戻し ----
-- 問題が起きた場合は、以下で元に戻せる:
--   grant insert, update, delete on public.local_expenses to anon, authenticated;
--   notify pgrst, 'reload schema';
