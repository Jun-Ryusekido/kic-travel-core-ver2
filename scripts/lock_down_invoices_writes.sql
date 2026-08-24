-- 【2026-08-24 本番実行済み】
--
-- セキュリティ中長期対応: invoices(請求書)への書き込みをservice_role経由に限定する。
--
-- 背景: invoicesは金銭データを扱う最重要テーブルの一つだが、tour_arrangement_headers等
-- 似た名前の別テーブルとの取り違えでservice_role移行対象から漏れ、anonキーからの
-- insert/update/deleteが直接可能な状態のまま放置されていた(2026-08点検で判明)。
-- booking_hotels/booking_costs/estimations等と同じ手順(service_role API化→
-- フロント切替→検証→REVOKE)で対応する。
--
-- 書き込み経路は以下の4パターンのみで、いずれも既に/api/table-crud(service_role key
-- 使用)経由に移行済み(invoicesApiCall()、api/table-crud.jsのTABLE_CONFIG.invoices参照):
--   1) 請求書の新規発行(generateInvoice、invoicesApiCall('insert', {rows:[...]}))
--   2) 請求書の失効/失効取り消し(同関数内、複数件一括status変更、
--      invoicesApiCall('updateByIds', {ids, fields:{status:'void'|'pending'}}))
--   3) 入金消込による自動ステータス更新(pending→paid、
--      invoicesApiCall('updateById', {id, fields:{status:'paid'}}))
--   4) Invoiceプレビュー項目の保存(saveInvoicePreviewFields、
--      invoicesApiCall('updateById', {id, fields:{...}}))
--   5) 予約削除時の一括削除(deleteBookingWithBackup、
--      invoicesApiCall('deleteByBooking', {bookingId}))
--
-- 読み取り(select)は今回変更しない。請求書一覧・PDF出力・入金消込判定等、既存の
-- 閲覧系機能は従来通りanonキー+RLS無効のまま動作する(anon/authenticatedからselectを
-- 剥奪すると壊れるため、意図的に対象外とする)。
--
-- 注意: invoicesにはcreated_by/updated_by列が無いため、api/table-crud.js側では
-- stampIdentityを有効化していない(auditLogのみ有効)。このSQLはGRANT/REVOKEのみを
-- 扱うものであり、列追加は別途必要になった場合に個別対応する。
--
-- 【実行タイミング】
-- 必ず、上記の書き込み経路が全てservice_role経由になっているコード(現在の本番)を
-- デプロイした状態で、実際に請求書の新規発行・再発行(void選択あり/なし)・入金消込による
-- ステータス更新が正常に動作することを確認してから実行すること(先にこのSQLを実行すると、
-- 古いJSを開いたままのタブからの操作が失敗する)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

-- ---- 実行前の確認(このSQLの本体を実行する前に、まず単独で実行して現状を確認すること) ----
-- 1) RLSの有効/無効(rowsecurityがtrueなら有効。今回はfalseのまま維持する)
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'invoices';

-- 2) anon/authenticated/service_roleへのGRANT状況
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'invoices'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- ---- 本体(上記の確認結果を見た上で、コードデプロイ・動作確認後に実行すること) ----
grant select, insert, update, delete on public.invoices to service_role;
revoke insert, update, delete on public.invoices from anon, authenticated;
-- selectは既存の一覧表示・PDF出力機能を壊さないため、anon/authenticatedから剥奪しない

notify pgrst, 'reload schema';

-- ---- 実行後の確認(本体実行後、再度このクエリを流して意図通りになったか確認すること) ----
-- anonはselectのみ、authenticatedは何も無し、service_roleは全権限、が期待値
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'invoices'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- ---- 切り戻し ----
-- 問題が起きた場合は、以下で元に戻せる:
--   grant insert, update, delete on public.invoices to anon, authenticated;
--   notify pgrst, 'reload schema';
