-- セキュリティ移行フェーズ グループ1・フェーズB(1/8テーブル目、再実行): booking_guides。
--
-- 【重要な経緯】
-- 初回のrevoke実行時、service_roleへのGRANTが未実施だったため
-- 「permission denied for table booking_guides」で保存が失敗し、一度grant文で
-- ロールバック済み。その後 scripts/fix_group1_service_role_grants.sql で対象8テーブル
-- 全てにservice_roleへのGRANTを投入し、「ガイド」タブ等での実際の保存動作を確認済み。
-- 今回はservice_role側の権限が整った状態での再実行。
--
-- このSQLで変わること:
-- ・anon/authenticatedからのINSERT/UPDATE/DELETEを禁止する
-- ・SELECTは残す(予約詳細のガイドタブ表示・二重アサインチェック等の閲覧系は
--   今回のスコープ外、従来通りanonキー+RLSのまま動作する)
-- ・service_roleは全権限を維持(/api/table-crudはこのキーで書き込む。
--   fix_group1_service_role_grants.sqlで付与済み)
--
-- 切り戻し(実行後に保存が失敗する等の問題が起きた場合、即座に以下で元に戻せる):
--   grant insert, update, delete on public.booking_guides to anon, authenticated;
--   notify pgrst, 'reload schema';

revoke insert, update, delete on public.booking_guides from anon, authenticated;

notify pgrst, 'reload schema';
