-- 予約台帳(bookings)の基本情報セクションに「FOC」欄を追加するための新規列。
-- 大人(pax_adult)/子供(pax_child)/乳児(pax_infant)と同じ並びに追加する人数欄で、
-- 無料(Free Of Charge)の同行者数を保持する。
--
-- 合計(TCP、bookings.pax列)の計算にはFOCを含めない方針とした(index.html側の
-- updateBdPaxTotal/saveBookingDetailを参照。bookings.paxは請求書発行対象の絞り込み・
-- レストラン/観光施設タブの新規行デフォルト人数・見積もり反映画面のPax表示等、
-- 課金・員数系の既存機能から広く参照されており、FOCを合算すると想定外の影響が
-- 出るリスクがあるため。詳細な調査結果はコミットメッセージ・報告を参照)。
--
-- GRANTは追加しない: bookingsテーブルは既にテーブル単位でGRANTされており
-- (Postgresの列単位GRANTは使っていない)、新規列は既存のGRANTに自動的に含まれる。
-- bookings書き込みは現在service_role経由(api/table-crud.js)に移行済みのフェーズに
-- あるため、ここで安易にGRANT文を書き足すと、既知でない現在の権限状態を意図せず
-- 上書き・拡張してしまうリスクがある(過去のRLS/GRANT変更による障害を踏まえ、
-- 列追加以外の権限変更はしない)。

alter table public.bookings add column if not exists foc_count integer;

notify pgrst, 'reload schema';
