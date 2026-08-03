-- セキュリティ移行フェーズ グループ1・フェーズB(6/8テーブル目): tour_arrangement_headers。
--
-- 前提確認済み(2026-08): information_schema.role_table_grantsに対する実クエリで、
-- service_roleに select/insert/update/delete が揃っていることを確認済み
-- (fix_group1_service_role_grants.sqlで付与済み)。
--
-- フェーズA(commit 2c9b1ca)で、saveArrDoc()のtour_arrangement_headers書き込みは
-- 既にtourArrangementHeadersApiCall('updateById'/'insertReturning', ...) →
-- /api/table-crud(service_role key)経由に切り替え済み。
--
-- このSQLで変わること:
-- ・anon/authenticatedからのINSERT/UPDATE/DELETEを禁止する
-- ・SELECTは残す(手配書の閲覧・Excel出力等は今回のスコープ外、従来通り
--   anonキー+RLSのまま動作する)
-- ・service_roleは全権限を維持(/api/table-crudはこのキーで書き込む)
--
-- 切り戻し(実行後に保存が失敗する等の問題が起きた場合、即座に以下で元に戻せる):
--   grant insert, update, delete on public.tour_arrangement_headers to anon, authenticated;
--   notify pgrst, 'reload schema';

revoke insert, update, delete on public.tour_arrangement_headers from anon, authenticated;

notify pgrst, 'reload schema';
