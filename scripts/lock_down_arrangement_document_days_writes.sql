-- セキュリティ移行フェーズ グループ1・フェーズB(7/8テーブル目): arrangement_document_days。
--
-- 前提確認済み(2026-08): information_schema.role_table_grantsに対する実クエリで、
-- service_roleに select/insert/update/delete が揃っていることを確認済み
-- (fix_group1_service_role_grants.sqlで付与済み)。
--
-- フェーズA(commit 2c9b1ca)で、arrangement_document_daysへの書き込みは
-- 以下の2箇所とも既にservice_role経由のAPIに切り替え済み:
-- ・saveGuideDocEditor()の置き換え保存 → arrangementDocumentDaysApiCall('replaceByKey', ...)
--   (キー列はarrangement_document_id、api/table-crud.js側の新設action)
-- ・syncArrangementDocumentsFromDraft()の新規手配書作成時のinsert →
--   arrangementDocumentDaysApiCall('insert', ...)
--
-- このSQLで変わること:
-- ・anon/authenticatedからのINSERT/UPDATE/DELETEを禁止する
-- ・SELECTは残す(ガイド別手配書の閲覧・Excel出力等は今回のスコープ外、従来通り
--   anonキー+RLSのまま動作する)
-- ・service_roleは全権限を維持(/api/table-crudはこのキーで書き込む)
--
-- 切り戻し(実行後に保存が失敗する等の問題が起きた場合、即座に以下で元に戻せる):
--   grant insert, update, delete on public.arrangement_document_days to anon, authenticated;
--   notify pgrst, 'reload schema';

revoke insert, update, delete on public.arrangement_document_days from anon, authenticated;

notify pgrst, 'reload schema';
