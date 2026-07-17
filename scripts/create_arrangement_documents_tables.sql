-- ガイド別手配書（arrangement_documents）関連テーブル作成用DDL。
-- このリポジトリのコードからは実行できない（publishable/anonキーではDDL権限がないため）。
-- Supabaseダッシュボードの SQL Editor で、管理者権限のセッションから手動実行すること。
--
-- 設計方針:
--   - 手配書は bookings に対して1対1ではなく、「予約(booking_id) × 担当ガイド(booking_guides行)」
--     に対して1対1で存在する（1件の予約に複数ガイドがいれば、手配書も複数できる）。
--   - 「共通ドラフト」（tour_arrangement_headers / tour_day_itinerary / tour_arrangement_notes、
--     いずれも既存テーブルで booking_id に1:1〜1:N）は今まで通りツアー全体の下書きとして残す。
--   - ガイド別手配書(arrangement_documents)は、共通ドラフトの保存タイミングで、まだ手配書を
--     持たない booking_guides 行に対して自動的に「その時点の共通ドラフトのスナップショット」
--     として作成される。ホテル名・レストラン名等はテキストとして複製し(FK参照ではない)、
--     以後の共通ドラフト側の編集やbooking_hotels等の変更とは完全に独立する。
--   - 一度作成された手配書は、共通ドラフト側やガイド別の他手配書に一切影響を与えずに
--     個別編集できる。
--   - RLSは、このアプリがSupabase Authを使わず独自のapp_usersテーブルでログイン管理しており
--     （auth.uid()は常に空）、他の運用テーブルと同様にpublishable（anon）キー1本で
--     全操作を行っているため、無効化する。

-- 1件 = 1予約 × 1担当ガイド分の手配書（ヘッダー情報を含む）
create table if not exists public.arrangement_documents (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  booking_guide_id uuid not null references public.booking_guides(id) on delete cascade,

  -- ヘッダー(共通ドラフトからのスナップショット。以後は個別編集可能)
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

  -- ガイド名・電話番号もスナップショット(以後 booking_guides / guides マスタの変更を追従しない)
  guide_name_snapshot text default '',
  guide_phone_snapshot text default '',

  status text not null default 'draft', -- draft(下書き) / final(確定)
  revision_no integer not null default 0,
  revision_note text,
  last_revised_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(booking_guide_id)
);

create index if not exists arrangement_documents_booking_id_idx on public.arrangement_documents(booking_id);
create index if not exists arrangement_documents_booking_guide_id_idx on public.arrangement_documents(booking_guide_id);

-- 日毎明細(1手配書に複数行)。tour_day_itineraryのarrangement_document_id版で、
-- hotel_name/lunch_name/dinner_name等は複製時点のテキストのスナップショット
-- （booking_hotels/booking_restaurantsへのFKではない）。
create table if not exists public.arrangement_document_days (
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

create index if not exists arrangement_document_days_doc_id_idx on public.arrangement_document_days(arrangement_document_id);

-- 注意文言(1手配書に4種)。tour_arrangement_notesのarrangement_document_id版。
create table if not exists public.arrangement_document_notes (
  id uuid primary key default gen_random_uuid(),
  arrangement_document_id uuid not null references public.arrangement_documents(id) on delete cascade,
  note_type text not null, -- fixed_template / mineral_water / driver_info / tour_specific
  content text default '',
  display_order integer default 0
);

create index if not exists arrangement_document_notes_doc_id_idx on public.arrangement_document_notes(arrangement_document_id);

alter table public.arrangement_documents disable row level security;
alter table public.arrangement_document_days disable row level security;
alter table public.arrangement_document_notes disable row level security;
