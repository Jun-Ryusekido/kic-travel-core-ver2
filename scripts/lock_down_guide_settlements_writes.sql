-- セキュリティ中長期対応 フェーズ1(最終): guide_settlements(ガイド精算)・
-- guide_settlement_items(精算明細)への書き込みをservice_role経由に限定する。
--
-- 背景: parking_reservations/booking_sales/booking_costs/local_expensesと同様、
-- これまでanonキーからinsert/update/deleteが直接可能な状態だった。
--
-- 対応: 社内スタッフ(index.html、ログインセッショントークン)・ガイド本人
-- (guide.html、精算リンクのaccess_token)いずれの書き込みも、/api/table-crud
-- (service_role key使用)経由に変更したため、anon/authenticatedロールからの
-- 直接書き込みを禁止する。
--
-- 読み取り(select)は今回変更しない。ガイド精算一覧・guide.htmlの表示・
-- 予約詳細のガイド精算セクション等、既存の閲覧系機能は従来通り
-- anonキー+RLSのまま動作する(guide.htmlのaccess_tokenによる該当精算の
-- 検索・表示も、これまで通りanon SELECTで行う)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

revoke insert, update, delete on public.guide_settlements from anon, authenticated;
revoke insert, update, delete on public.guide_settlement_items from anon, authenticated;

-- service_roleは/api/table-crud(service_role key使用)が必要とするため、
-- 明示的に権限を残す(select含め、読み取り確認等でも使えるようにフルアクセスにしておく)。
grant select, insert, update, delete on public.guide_settlements to service_role;
grant select, insert, update, delete on public.guide_settlement_items to service_role;

notify pgrst, 'reload schema';
