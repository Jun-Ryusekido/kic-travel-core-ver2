-- 取引先マスタ担当者複数対応・フェーズ2: 既存データの移行。
--
-- 背景: business_partners(有効行、is_deleted is not true)594件のうち、
-- contact_person が入力済みの187件について、その担当者情報を
-- business_partner_contacts へ1行ずつコピーする(「元からの担当者」を
-- business_partner_contacts側でも参照できるようにするための移行)。
-- 論理削除済み(is_deleted=true)側のcontact_person入り1件は対象外とする
-- (2026/08/26時点で全996件中、is_deleted=true 402件・有効594件、うち
-- 有効側でcontact_person入りが187件であることを確認済み)。
--
-- business_partners側の元データ(contact_person等の列)は本移行では一切
-- 削除・変更しない。business_partners自体のRLS/GRANTにも触れない。
--
-- 実行順序:
--   1) 下記(1)のSELECTで移行対象187件の内容を確認する
--   2) 件数(187件)が一致することを確認した上で、下記(2)のINSERTを実行する
--      (実行前に必ずbusiness_partner_contactsが空、または本移行分
--      (created_by='migration_phase2')がまだ入っていないことを確認すること。
--      再実行すると同じ担当者が重複して増えるため、二重実行防止のガードを
--      INSERT文自体にもwhere not existsで入れてある)
--   3) 実行後、business_partners側の有効な会社の総数が594件のまま
--      変わっていないことを(3)のSELECTで確認する

-- (1) 移行対象187件の確認用SELECT
select
  id as business_partner_id,
  company_name,
  contact_person, contact_person_en, position, position_en,
  branch_name, branch_name_en, phone, department_phone, email,
  show_contact_phone, show_department_phone
from public.business_partners
where (is_deleted is null or is_deleted = false)
  and contact_person is not null
  and trim(contact_person) <> ''
order by company_name, id;
-- ※実行結果が187件であることを確認すること。

-- (2) 移行用INSERT(重複実行防止のガード付き)
-- 実行前に必ず、business_partner_contactsに created_by='migration_phase2' の行が
-- まだ存在しない(= 本移行が未実施)ことを確認すること。
--   select count(*) from public.business_partner_contacts where created_by = 'migration_phase2';
--   → 0件であることを確認してから実行する。
insert into public.business_partner_contacts (
  business_partner_id, contact_person, contact_person_en, position, position_en,
  branch_name, branch_name_en, phone, department_phone, email,
  show_contact_phone, show_department_phone, created_by, created_at
)
select
  bp.id, bp.contact_person, bp.contact_person_en, bp.position, bp.position_en,
  bp.branch_name, bp.branch_name_en, bp.phone, bp.department_phone, bp.email,
  bp.show_contact_phone, bp.show_department_phone, 'migration_phase2', now()
from public.business_partners bp
where (bp.is_deleted is null or bp.is_deleted = false)
  and bp.contact_person is not null
  and trim(bp.contact_person) <> ''
  and not exists (
    select 1 from public.business_partner_contacts bpc
    where bpc.business_partner_id = bp.id and bpc.created_by = 'migration_phase2'
  );

-- (3) 移行後の確認: 有効な会社の総数が594件のまま変わっていないこと、
-- および今回の移行で187件が業者id重複なく追加されたことを確認する
select count(*) as active_business_partners
from public.business_partners
where (is_deleted is null or is_deleted = false);

select count(*) as migrated_contacts
from public.business_partner_contacts
where created_by = 'migration_phase2';
