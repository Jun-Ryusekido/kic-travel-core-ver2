-- セキュリティ移行バッチA: booking_hotels/booking_buses/booking_restaurants/
-- booking_facilities への書き込みをすべてservice_role経由に限定し、監査ログ機能
-- (誰が変更したか)の前提となるcreated_by/updated_by列を追加する。
--
-- 背景: これまでこの4テーブルは、予約詳細モーダルの各タブ保存(旧
-- safeReplaceBookingRows)、ホテル管理ページの重複解消モーダル、ステータスクイック
-- 切替、ダッシュボードToDoの完了/削除操作等、すべてanonキーからの直接
-- insert/update/deleteだった。今回、これらをすべて/api/table-crud.js(service_role
-- key使用)経由の呼び出し(bookingHotelsApiCall/bookingBusesApiCall/
-- bookingRestaurantsApiCall/bookingFacilitiesApiCall)に置き換えたため、
-- anon/authenticatedロールからの直接書き込みを禁止する。
--
-- 読み取り(select)は今回変更しない。一覧表示・ダブルブッキングチェック等、既存の
-- 閲覧系機能は従来通りanonキー+RLSのまま動作する。
--
-- created_by/updated_byの値は、api/table-crud.jsがverifySessionTokenで検証済みの
-- セッショントークンから取り出したemailのみをサーバー側で自動スタンプする
-- (クライアントが送ってきた値は一切使わない)。
--
-- 対象4テーブルすべての書き込み経路がservice_role経由に統一されたため、
-- 2段階に分けず、このファイル1回の実行でGRANT→ALTER→NOTIFY→REVOKEまで完結する。
--
-- Supabaseダッシュボードの SQL Editor で、上から順(1→5)に実行すること。

-- 1) service_roleへのGRANT
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

-- 5) anon/authenticatedロールからのDML権限REVOKE(対象4テーブル全て)
revoke insert, update, delete on public.booking_hotels from anon, authenticated;
revoke insert, update, delete on public.booking_buses from anon, authenticated;
revoke insert, update, delete on public.booking_restaurants from anon, authenticated;
revoke insert, update, delete on public.booking_facilities from anon, authenticated;
