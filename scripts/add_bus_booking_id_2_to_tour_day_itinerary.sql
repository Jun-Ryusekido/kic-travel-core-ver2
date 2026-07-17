-- 新幹線区間を挟む日は、乗車前後でバス会社が乗り換わるのが通常パターンであるため、
-- tour_day_itinerary(手配書「共通ドラフト」の日毎明細)の1日分のレコードに、
-- バス会社を「前半(新幹線利用前)」「後半(新幹線利用後)」の2つ分持てるようにする。
-- 既存の bus_booking_id / bus_company_text は「前半(新幹線利用前、または新幹線利用なしの
-- 通常日はその日全体)」の扱いとし、後半用の列を新設する。
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.tour_day_itinerary
  add column if not exists bus_booking_id_2 uuid references public.booking_buses(id) on delete set null,
  add column if not exists bus_company_text_2 text default '';

create index if not exists tour_day_itinerary_bus_booking_id_2_idx on public.tour_day_itinerary(bus_booking_id_2);

notify pgrst, 'reload schema';
