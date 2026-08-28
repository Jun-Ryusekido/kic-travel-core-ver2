-- 売上明細・手配管理タブのドラッグ&ドロップ並び替え機能のためのsort_order列追加。
--
-- 背景: booking_hotels/bullet_train_arrangementsには既にsort_order列があり、
-- 保存(doReplace方式、全削除→全再挿入)のたびに配列の並び順をsort_order: i として
-- 書き込み、読み込み時は.order('sort_order')で復元する仕組みが既に動いていた
-- (ただし手動並び替えUIは無く、単に保存時点の配列順を記録するだけだった)。
--
-- 今回、売上明細・手配管理の残り6タブ(booking_sales/booking_buses/
-- booking_restaurants/booking_facilities/booking_water_items/booking_guides)にも
-- ドラッグ&ドロップ並び替えUIを追加するにあたり、同じsort_order列・同じ実装
-- パターンに統一する(案B: INSERT順=SELECT順への依存は、PostgRESTがORDER BY省略時の
-- 順序を保証しないため不採用)。
--
-- 列追加直後は既存行がすべてsort_order=NULLになるが、読み込みクエリを
-- .order('sort_order').order('created_at') のように2段構えにしているため、
-- Postgresの既定(ASCはNULLS LAST)により「sort_order未設定の行はcreated_at順
-- (=従来通りの登録順)で表示される」→ 一度でも保存すると以後は明示的なsort_order
-- が振られ、その順序が維持される。既存予約への影響(データ消失・エラー)はない。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.booking_sales add column if not exists sort_order integer;
alter table public.booking_buses add column if not exists sort_order integer;
alter table public.booking_restaurants add column if not exists sort_order integer;
alter table public.booking_facilities add column if not exists sort_order integer;
alter table public.booking_water_items add column if not exists sort_order integer;
alter table public.booking_guides add column if not exists sort_order integer;

notify pgrst, 'reload schema';
