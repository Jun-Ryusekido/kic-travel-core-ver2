-- 手配タブ(ホテル・バス・ミネラルウォーター・新幹線・ガイド)のpayment_method列に、
-- 統一前の選択肢だった「前振込み」として保存されているデータが万一あれば、
-- 仮払い一覧表側の語彙に合わせて「事前決済」に読み替える。
--
-- 該当が無いテーブル・行に対しては何も変更しないため、複数回実行しても安全(冪等)。
-- 実行前に対象行数を確認したい場合は、まず下記のUPDATE文の前に
-- 「select count(*) from public.xxx where payment_method = '前振込み';」で確認すること。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

update public.booking_hotels set payment_method = '事前決済' where payment_method = '前振込み';
update public.booking_buses set payment_method = '事前決済' where payment_method = '前振込み';
update public.booking_water_items set payment_method = '事前決済' where payment_method = '前振込み';
update public.bullet_train_arrangements set payment_method = '事前決済' where payment_method = '前振込み';
update public.booking_guides set payment_method = '事前決済' where payment_method = '前振込み';
