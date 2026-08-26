-- 予約台帳「基本情報」レイアウト変更(メモ3削除・メモ1/メモ2統合)の事前確認用。
-- 実装コード側(index.html)は「データは実質存在しない」という前提で進めているが、
-- 念のためデプロイ前にSupabase SQL Editorで実行し、結果を確認してから進めること。
--
-- このセッションからは本番Supabaseに接続できないため、実行結果の確認自体は
-- 実施できていない。以下のいずれかで1件でもヒットした場合は、コードの
-- マージ処理(index.htmlのopenBookingDetail、メモ1+メモ2の連結ロジック)が
-- 正しく機能しているか、該当予約を実際に開いて確認すること。

-- (1) memo3に値が入っている予約(削除対象。データは保持不要とのことだが、
--     件数を把握しておく)
select id, ref_no, tour_name, memo3
from public.bookings
where memo3 is not null and trim(memo3) <> '';

-- (2) memo1・memo2の両方に値が入っている予約(統合時に連結が必要になるケース)
select id, ref_no, tour_name, memo1, memo2
from public.bookings
where memo1 is not null and trim(memo1) <> ''
  and memo2 is not null and trim(memo2) <> '';

-- (3) memo1・memo2のいずれか一方にのみ値が入っている予約(統合後もそのまま
--     「備考」欄に引き継がれるため実害は無いが、件数の把握用)
select count(*) as memo1_or_memo2_only
from public.bookings
where (memo1 is not null and trim(memo1) <> '')
   <> (memo2 is not null and trim(memo2) <> '');
