-- 支払方法の表記統一(「後請求」→「請求書払い」)に伴い、既存データで「後請求」として
-- 保存されている行があれば「請求書払い」に読み替える。
--
-- 対象は、支払方法にLOCAL_EXPENSE_PAYMENT_METHODS(現地払い/事前決済/後請求→請求書払い/
-- 全旅クーポン/無料(FREE))の語彙を使っている全テーブル。レストラン(booking_restaurants)は
-- 元々「請求書払い/現金払い/その他」という別語彙で「後請求」という値は使っていないため対象外。
--
-- 該当行が無いテーブルには何も変更しないため、複数回実行しても安全(冪等)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

update public.local_expenses set payment_method = '請求書払い' where payment_method = '後請求';
update public.booking_facilities set payment_method = '請求書払い' where payment_method = '後請求';
update public.booking_hotels set payment_method = '請求書払い' where payment_method = '後請求';
update public.booking_buses set payment_method = '請求書払い' where payment_method = '後請求';
update public.booking_water_items set payment_method = '請求書払い' where payment_method = '後請求';
update public.bullet_train_arrangements set payment_method = '請求書払い' where payment_method = '後請求';
update public.booking_guides set payment_method = '請求書払い' where payment_method = '後請求';
