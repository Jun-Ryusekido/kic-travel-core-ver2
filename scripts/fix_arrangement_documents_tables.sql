-- arrangement_documents / arrangement_document_days / arrangement_document_notes が
-- 想定より少ない列(id・booking_id・created_at等の一部のみ)しか持っておらず、
-- 過去のいずれかの時点で不完全な状態で作成されてしまっていたことが判明したための修正用DDL。
-- 3テーブルとも現時点でデータは0件のため、安全にDROPして正しい定義で作り直す。
-- Supabaseダッシュボードの SQL Editor で実行すること。

drop table if exists public.arrangement_document_notes cascade;
drop table if exists public.arrangement_document_days cascade;
drop table if exists public.arrangement_documents cascade;

-- 以降は scripts/create_arrangement_documents_tables.sql と同一内容(作り直し)。

create table public.arrangement_documents (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  booking_guide_id uuid not null references public.booking_guides(id) on delete cascade,

  bus_signage_name text default '',
  nationality text default '',
  pax_adult integer default 0,
  pax_child integer default 0,
  pax_note text default '',
  arr_date date,
  arr_airport text default '',
  arr_flight text default '',
  arr_time text default '',
  dep_date date,
  dep_airport text default '',
  dep_flight text default '',
  dep_time text default '',

  guide_name_snapshot text default '',
  guide_phone_snapshot text default '',

  status text not null default 'draft',
  revision_no integer not null default 0,
  revision_note text,
  last_revised_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(booking_guide_id)
);

create index arrangement_documents_booking_id_idx on public.arrangement_documents(booking_id);
create index arrangement_documents_booking_guide_id_idx on public.arrangement_documents(booking_guide_id);

create table public.arrangement_document_days (
  id uuid primary key default gen_random_uuid(),
  arrangement_document_id uuid not null references public.arrangement_documents(id) on delete cascade,
  day_no integer not null,
  date date,
  bus_company_text text default '',
  itinerary_text text default '',
  others_text text default '',
  hotel_name text default '',
  hotel_phone text default '',
  hotel_note text default '',
  breakfast_text text default '',
  breakfast_time text default '',
  breakfast_phone text default '',
  lunch_text text default '',
  lunch_time text default '',
  lunch_phone text default '',
  dinner_text text default '',
  dinner_time text default '',
  dinner_phone text default '',
  departure_time text
);

create index arrangement_document_days_doc_id_idx on public.arrangement_document_days(arrangement_document_id);

create table public.arrangement_document_notes (
  id uuid primary key default gen_random_uuid(),
  arrangement_document_id uuid not null references public.arrangement_documents(id) on delete cascade,
  note_type text not null,
  content text default '',
  display_order integer default 0
);

create index arrangement_document_notes_doc_id_idx on public.arrangement_document_notes(arrangement_document_id);

alter table public.arrangement_documents disable row level security;
alter table public.arrangement_document_days disable row level security;
alter table public.arrangement_document_notes disable row level security;

grant select, insert, update, delete on public.arrangement_documents to anon, authenticated, service_role;
grant select, insert, update, delete on public.arrangement_document_days to anon, authenticated, service_role;
grant select, insert, update, delete on public.arrangement_document_notes to anon, authenticated, service_role;

notify pgrst, 'reload schema';
