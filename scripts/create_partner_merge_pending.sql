-- 名刺スキャン自動マージ・確認バナー機能のための新規テーブル。
--
-- 名刺OCR(processCardFile/batchSaveAndNext)で重複候補が検出された際、その場で
-- マージ/新規登録を即決せず「後で確認する(保留)」を選べるようにするため、
-- OCR結果一式と重複候補のbusiness_partners.idを一時的に保持する。
--
-- 新設テーブルのため、guide_bank_accounts等と同じ方針で最初からservice_role専用の
-- 書き込みとし(anonへの直接insert/update/delete GRANTは一切行わない)、
-- 書き込みは/api/table-crud経由(partnerMergePendingApiCall)のみとする。
-- 読み取り(select)は確認バナーの件数表示・保留一覧の表示に必要なため、
-- 他の閲覧系機能と同様にanon/authenticatedにも許可する。
--
-- ocr_dataは、business_partnersのinsert/update時と同じ列名構成
-- (category, company_name, company_name_en, branch_name, branch_name_en,
-- contact_person, contact_person_en, position, position_en, company_phone,
-- phone, fax, email, address, address_en)のJSONとして保存し、保留一覧からの
-- 「マージする/新規登録する」処理でそのままbusiness_partnersへの書き込みに使えるようにする。
--
-- candidate_partner_idはbusiness_partners.idへの外部キー。参照先が削除された場合でも
-- 保留データ自体は失われないよう、on delete set nullとする(その場合、保留一覧側で
-- 「対象の取引先が見つかりません」と表示し、新規登録/破棄のみ選べるようにする)。

create table if not exists public.partner_merge_pending (
  id uuid primary key default gen_random_uuid(),
  ocr_data jsonb not null,
  candidate_partner_id uuid references public.business_partners(id) on delete set null,
  status text not null default 'pending',
  scanned_by text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

grant select on public.partner_merge_pending to anon, authenticated;
grant select, insert, update, delete on public.partner_merge_pending to service_role;

notify pgrst, 'reload schema';
