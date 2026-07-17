-- 「手配書」タブ用の新規テーブル4種の作成DDL。
-- このリポジトリのコードからは実行できない（publishable/anonキーではDDL権限がないため）。
-- Supabaseダッシュボードの SQL Editor で、管理者権限のセッションから手動実行すること。
--
-- 設計方針:
--   - tour_arrangement_headers は bookings と1:1（booking_id に unique 制約）。
--   - tour_guides / tour_day_itinerary / tour_arrangement_notes は booking_buses 等と同様、
--     1つの booking_id に対して複数行を持てる明細テーブル。
--   - tour_day_itinerary の hotel_booking_id / lunch_restaurant_booking_id /
--     dinner_restaurant_booking_id は、既存の booking_hotels / booking_restaurants への
--     参照。予約詳細モーダル側で該当ホテル/レストラン行が削除された場合に
--     tour_day_itinerary側のレコードごと消えてしまわないよう on delete set null にしている
--     （FK先が無くなった場合は、選択が外れて自由記述欄のみが残る形になる）。
--   - RLSは、このアプリがSupabase Authを使わず独自のapp_usersテーブルでログイン管理しており
--     （auth.uid()は常に空）、booking_buses等の既存の運用テーブルと同様にpublishable
--     （anon）キー1本で全操作を行っているため、他の運用テーブルに合わせて無効化する。

create table if not exists public.tour_arrangement_headers (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete cascade,
  bus_signage_name text,
  nationality text,
  pax_adult integer default 0,
  pax_child integer default 0,
  pax_note text,
  arr_date date,
  arr_airport text,
  arr_flight text,
  arr_time text,
  dep_date date,
  dep_airport text,
  dep_flight text,
  dep_time text,
  status text not null default 'draft',
  revision_no integer not null default 0,
  revision_note text,
  last_revised_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tour_arrangement_headers_booking_id_idx on public.tour_arrangement_headers(booking_id);
alter table public.tour_arrangement_headers disable row level security;

create table if not exists public.tour_guides (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  guide_id uuid references public.guides(id) on delete set null,
  guide_name_freetext text,
  phone text,
  start_date date,
  display_order integer default 0,
  created_at timestamptz not null default now()
);
create index if not exists tour_guides_booking_id_idx on public.tour_guides(booking_id);
create index if not exists tour_guides_guide_id_idx on public.tour_guides(guide_id);
alter table public.tour_guides disable row level security;

create table if not exists public.tour_day_itinerary (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  day_no integer not null,
  date date,
  bus_company_text text,
  bus_booking_id uuid references public.booking_buses(id) on delete set null,
  itinerary_text text,
  others_text text,
  hotel_booking_id uuid references public.booking_hotels(id) on delete set null,
  hotel_note text,
  breakfast_text text,
  breakfast_time text,
  breakfast_phone text,
  lunch_restaurant_booking_id uuid references public.booking_restaurants(id) on delete set null,
  lunch_text text,
  lunch_time text,
  lunch_phone text,
  dinner_restaurant_booking_id uuid references public.booking_restaurants(id) on delete set null,
  dinner_text text,
  dinner_time text,
  dinner_phone text,
  departure_time time,
  created_at timestamptz not null default now()
);
create index if not exists tour_day_itinerary_booking_id_idx on public.tour_day_itinerary(booking_id);
create index if not exists tour_day_itinerary_bus_booking_id_idx on public.tour_day_itinerary(bus_booking_id);
create index if not exists tour_day_itinerary_hotel_booking_id_idx on public.tour_day_itinerary(hotel_booking_id);
create index if not exists tour_day_itinerary_lunch_restaurant_booking_id_idx on public.tour_day_itinerary(lunch_restaurant_booking_id);
create index if not exists tour_day_itinerary_dinner_restaurant_booking_id_idx on public.tour_day_itinerary(dinner_restaurant_booking_id);
alter table public.tour_day_itinerary disable row level security;

create table if not exists public.tour_arrangement_notes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  note_type text not null,
  content text,
  display_order integer default 0,
  created_at timestamptz not null default now()
);
create index if not exists tour_arrangement_notes_booking_id_idx on public.tour_arrangement_notes(booking_id);
alter table public.tour_arrangement_notes disable row level security;
