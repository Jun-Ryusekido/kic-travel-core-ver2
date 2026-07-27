-- セキュリティ中長期対応 フェーズ2: business_partners(取引先マスタ)への
-- 書き込みをservice_role経由に限定する。
--
-- 背景: フェーズ1(金銭関連テーブル: parking_reservations/booking_sales/
-- booking_costs/local_expenses/guide_settlements/guide_settlement_items)と
-- 同様、business_partnersもこれまでanonキーからinsert/update/deleteが
-- 直接可能な状態だった。
--
-- 対応: 取引先マスタ画面の新規登録・編集(savePartner)、仕入先サジェストからの
-- クイック追加(registerNewSupplier)、名刺OCR一括登録(batchSaveAndNext)、
-- 論理削除・復元(deletePartner/restorePartner)、完全削除
-- (permanentlyDeletePartner)を全てservice_role key経由の/api/table-crudに
-- 変更したため、anon/authenticatedロールからの直接書き込みを禁止する。
--
-- 読み取り(select)は今回変更しない。取引先マスタ一覧・レストラン/バス/仕入先の
-- サジェスト機能・メール受信箱の取引先ドメイン判定等、既存の閲覧系機能は
-- 従来通りanonキー+RLSのまま動作する。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

revoke insert, update, delete on public.business_partners from anon, authenticated;

-- service_roleは/api/table-crud(service_role key使用)が必要とするため、
-- 明示的に権限を残す(select含め、読み取り確認等でも使えるようにフルアクセスにしておく)。
grant select, insert, update, delete on public.business_partners to service_role;

notify pgrst, 'reload schema';
