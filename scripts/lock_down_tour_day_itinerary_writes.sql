-- セキュリティ移行フェーズ グループ1・フェーズB(3/8テーブル目): tour_day_itinerary。
--
-- 前提確認済み(2026-08): information_schema.role_table_grantsに対する実クエリで、
-- service_roleに select/insert/update/delete が揃っていることを確認済み
-- (fix_group1_service_role_grants.sqlで付与済み)。booking_guides/tour_guidesで
-- このGRANT確認を怠ったまま先にrevokeしてしまい保存が全面的に壊れた事故の
-- 再発防止として、今回から revoke の前に必ずGRANT状況を確認する運用に変更。
--
-- フェーズA(commit 2c9b1ca)で、saveArrDoc()のtour_day_itinerary書き込みは
-- 既にtourDayItineraryApiCall('replace', ...) → /api/table-crud(service_role key)経由に
-- 切り替え済み。
--
-- このSQLで変わること:
-- ・anon/authenticatedからのINSERT/UPDATE/DELETEを禁止する
-- ・SELECTは残す(手配書の閲覧・Excel出力等は今回のスコープ外、従来通り
--   anonキー+RLSのまま動作する)
-- ・service_roleは全権限を維持(/api/table-crudはこのキーで書き込む)
--
-- 切り戻し(実行後に保存が失敗する等の問題が起きた場合、即座に以下で元に戻せる):
--   grant insert, update, delete on public.tour_day_itinerary to anon, authenticated;
--   notify pgrst, 'reload schema';

revoke insert, update, delete on public.tour_day_itinerary from anon, authenticated;

notify pgrst, 'reload schema';
