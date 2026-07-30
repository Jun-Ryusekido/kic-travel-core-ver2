-- セキュリティ移行バッチA: booking_hotels/booking_buses/booking_restaurants への
-- 書き込みをservice_role経由に限定し、監査ログ機能(誰が変更したか)の前提となる
-- created_by/updated_by列を4テーブル(+booking_facilities)に追加する。
--
-- 背景: これまでbooking_hotels/booking_buses/booking_restaurantsは、予約詳細モーダルの
-- 保存(旧safeReplaceBookingRows)、ホテル管理ページの重複解消モーダル、ステータス
-- クイック切替等、すべてanonキーからの直接insert/update/deleteだった。今回、これらを
-- すべて/api/table-crud.js(service_role key使用)経由の呼び出し(bookingHotelsApiCall/
-- bookingBusesApiCall/bookingRestaurantsApiCall)に置き換えたため、anon/authenticated
-- ロールからの直接書き込みを禁止する。
--
-- 読み取り(select)は今回変更しない。一覧表示・ダブルブッキングチェック等、既存の
-- 閲覧系機能は従来通りanonキー+RLSのまま動作する。
--
-- created_by/updated_byの値は、api/table-crud.jsがverifySessionTokenで検証済みの
-- セッショントークンから取り出したemailのみをサーバー側で自動スタンプする
-- (クライアントが送ってきた値は一切使わない)。
--
-- Supabaseダッシュボードの SQL Editor で、上から順(1→5)に実行すること。

-- 1) service_roleへのGRANT
--    booking_hotels/booking_buses/booking_restaurantsは今回初めてservice_role経由の
--    書き込みが発生するため必須。booking_facilitiesは既に付与済みのはずだが、
--    念のため再実行しても害はない(idempotent)。
grant select, insert, update, delete on public.booking_hotels to service_role;
grant select, insert, update, delete on public.booking_buses to service_role;
grant select, insert, update, delete on public.booking_restaurants to service_role;
grant select, insert, update, delete on public.booking_facilities to service_role;

-- 2) created_by/updated_by列の追加(対象4テーブル共通。監査ログ機能の前提整備)
alter table public.booking_hotels add column if not exists created_by text;
alter table public.booking_hotels add column if not exists updated_by text;

alter table public.booking_buses add column if not exists created_by text;
alter table public.booking_buses add column if not exists updated_by text;

alter table public.booking_restaurants add column if not exists created_by text;
alter table public.booking_restaurants add column if not exists updated_by text;

alter table public.booking_facilities add column if not exists created_by text;
alter table public.booking_facilities add column if not exists updated_by text;

-- 3) booking_buses/booking_restaurantsのみ、updated_at相当の列が無かったため追加する
--    (booking_hotelsは既存のstatus_updated_at列、booking_facilitiesは
--    deadline_completed_at列がそれぞれあるため対象外)
alter table public.booking_buses add column if not exists updated_at timestamptz;
alter table public.booking_restaurants add column if not exists updated_at timestamptz;

-- 4) PostgRESTのスキーマキャッシュを新しい列に追従させる
notify pgrst, 'reload schema';

-- 5) anon/authenticatedロールからのDML権限REVOKE
--    booking_hotels/booking_buses/booking_restaurantsの3テーブルのみ実行する。
--    全ての書き込み経路がservice_role経由に統一されたため、この3テーブルは
--    revokeして問題ない。
revoke insert, update, delete on public.booking_hotels from anon, authenticated;
revoke insert, update, delete on public.booking_buses from anon, authenticated;
revoke insert, update, delete on public.booking_restaurants from anon, authenticated;

-- ⚠ booking_facilitiesは意図的にREVOKEしていません。
-- 予約詳細モーダルの「観光施設」タブ保存(saveFacilityItems、index.html:10902)が
-- 今回のスコープ外で、safeReplaceBookingRows経由のanon直接insert/deleteのまま
-- 残っているため、ここでbooking_facilitiesのanon DML権限をREVOKEすると、その
-- タブの保存機能が即座に壊れます。この最後の1経路をservice_role経由に移行してから、
-- 以下を実行してください(このファイルには含めていません):
--   revoke insert, update, delete on public.booking_facilities from anon, authenticated;
