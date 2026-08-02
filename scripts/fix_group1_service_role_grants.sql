-- セキュリティ移行フェーズ グループ1・緊急修正: service_roleへのGRANT漏れの是正。
--
-- 【経緯】
-- フェーズB(booking_guides/tour_guidesのanon revoke)実行後、「permission denied for
-- table booking_guides」エラーで保存が失敗した。原因は、フェーズBのSQL提示時に
-- 過去の全ロックダウンSQL(lock_down_email_import_queue_writes.sql等)が必ず含んでいた
-- 「grant ... to service_role」の記載が漏れていたこと。
--
-- フェーズA(commit 2c9b1ca)で対象8テーブルは全てservice_role経由のAPI
-- (/api/table-crud)に書き込みが切り替わっているため、service_role自体に
-- INSERT/UPDATE/DELETEのGRANTが無いテーブルは、anonのrevoke有無に関わらず
-- 保存が失敗する状態になっていた可能性がある。
--
-- このSQLは anon/authenticated の権限には一切触れない(安全に何度でも実行できる、
-- 既にrevoke済みのbooking_guides/tour_guidesにも、まだrevokeしていない残り6テーブルにも
-- 影響しない)。service_roleへのGRANTを対象8テーブル全てに確実に入れ直すだけ。

grant select, insert, update, delete on public.booking_guides to service_role;
grant select, insert, update, delete on public.tour_guides to service_role;
grant select, insert, update, delete on public.tour_day_itinerary to service_role;
grant select, insert, update, delete on public.tour_arrangement_notes to service_role;
grant select, insert, update, delete on public.booking_water_items to service_role;
grant select, insert, update, delete on public.tour_arrangement_headers to service_role;
grant select, insert, update, delete on public.arrangement_document_days to service_role;
grant select, insert, update, delete on public.arrangement_document_notes to service_role;

notify pgrst, 'reload schema';

-- 上記実行後、booking_guides/tour_guidesは既にgrant文でロールバック済み(anon権限が
-- 戻っている状態)なので、いったんこの状態のまま「ガイド」タブ・「手配書」タブで
-- 実際に保存できることを確認すること。
-- 確認できたら、あらためてbooking_guides/tour_guidesのみ、以下でanon/authenticatedの
-- 書き込み権限を再度剥奪する(service_roleのGRANTは今回のSQLで既に入っているため、
-- 今度こそ正常に動作するはず)。
--
-- revoke insert, update, delete on public.booking_guides from anon, authenticated;
-- revoke insert, update, delete on public.tour_guides from anon, authenticated;
-- notify pgrst, 'reload schema';
