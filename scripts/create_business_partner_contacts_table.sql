-- 取引先マスタ(business_partners)に複数の担当者を紐付けられるようにするための
-- 新規テーブル(フェーズ1・最小限)。
--
-- 背景: business_partners は「1行=会社1社+担当者1人」の設計のため、同じ会社
-- (例: 同じホテル)に複数の担当者(予約担当・営業担当・支店等)を登録しようとすると、
-- 名刺スキャン・新規取引先登録時の会社名完全一致チェック(api/table-crud.js
-- findExactDuplicateBusinessPartner)にブロックされてしまう。今回のフェーズ1では
-- business_partners自体には一切手を入れず、別テーブルに担当者を追加登録できる
-- 経路だけを新設する。
--
-- 新設テーブルのため、tour_arrangements/partner_merge_pending等と同じ方針で
-- 最初からservice_role専用の書き込みとする(anonへの直接insert/update/delete GRANTは
-- 一切行わない。書き込みは/api/table-crud経由のみ)。RLSは他の運用中テーブルと同様、
-- シンプルにdisableし、権限はGRANT側のみで制御する
-- (2026-08-26、RLS/ポリシー変更で全予約の売上明細が非表示になった障害を踏まえ、
-- business_partners自体のRLS/GRANTには一切触れない)。
--
-- 読み取り(select)は取引先マスタ一覧画面での担当者一覧表示に必要なため、
-- 他の閲覧系テーブルと同様にanon/authenticatedにも許可する。

create table if not exists public.business_partner_contacts (
  id uuid primary key default gen_random_uuid(),
  business_partner_id uuid not null references public.business_partners(id),
  contact_person text,
  contact_person_en text,
  position text,
  position_en text,
  branch_name text,
  branch_name_en text,
  phone text,
  department_phone text,
  email text,
  show_contact_phone boolean,
  show_department_phone boolean,
  is_deleted boolean not null default false,
  deleted_at timestamptz,
  deleted_by text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now()
);

create index if not exists idx_business_partner_contacts_partner_id
  on public.business_partner_contacts(business_partner_id);

alter table public.business_partner_contacts disable row level security;

grant select on public.business_partner_contacts to anon, authenticated;
grant select, insert, update, delete on public.business_partner_contacts to service_role;

notify pgrst, 'reload schema';
