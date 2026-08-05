-- 業務フロー点検 対応②: booking_costsの各行が「仕入明細へ追加」ボタン経由で作られた場合、
-- 追加元の手配データ(booking_hotels/booking_buses/booking_restaurants/booking_facilities/
-- booking_water_itemsのいずれか)を追跡できるようにする。
--
-- - source_table: 追加元テーブル名(例: 'booking_hotels')。手動入力等、追加元を持たない
--   行はNULLのまま(過去分含む)。
-- - source_id: 追加元テーブルの該当行id。
-- - source_snapshot: 追加時点の追加元の内容(仕入先名・日付表示)のスナップショット
--   (jsonb、例: {"item_name":"○○ホテル","date_display":"2026-09-01"}）。
--   以後、追加元が編集されたかどうかをこのスナップショットとの差分で検知するために使う
--   (自動反映はしない。画面上に警告を出すのみ)。
--
-- 実行方法: Supabase SQL Editorで実行してください。既存データへの影響はありません
-- (新規列はすべてNULL許容・デフォルト値なしで追加するのみ)。

ALTER TABLE booking_costs
  ADD COLUMN IF NOT EXISTS source_table text,
  ADD COLUMN IF NOT EXISTS source_id uuid,
  ADD COLUMN IF NOT EXISTS source_snapshot jsonb;
