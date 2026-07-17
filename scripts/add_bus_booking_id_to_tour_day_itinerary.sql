-- tour_day_itinerary(手配書「共通ドラフト」の日毎明細)に、booking_busesへの参照列を追加する。
-- 目的: バス会社をホテル/レストランと同様に「booking_busesから選択 or 自由記述」にし、
-- バス会社名の二重管理(共通ドラフト側で別途テキスト入力し直す必要がある状態)を解消する。
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.tour_day_itinerary
  add column if not exists bus_booking_id uuid references public.booking_buses(id) on delete set null;

create index if not exists tour_day_itinerary_bus_booking_id_idx on public.tour_day_itinerary(bus_booking_id);

notify pgrst, 'reload schema';
