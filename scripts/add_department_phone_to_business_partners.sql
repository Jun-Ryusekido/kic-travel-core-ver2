-- 取引先マスタ(business_partners)の電話番号を3層構造にする。
-- 1. phone(既存)            → 担当者直通・携帯番号(最優先)
-- 2. department_phone(新設)  → 部署の直通番号(2番目)
-- 3. company_phone(既存)     → 会社の代表番号(3番目、他が空の場合のみ)
--
-- 列名変更・削除は行わない(既存コードへの影響範囲が広いため)。新規列は
-- NULL許容・デフォルト値なしで追加するのみで、既存データへの影響は無い。
--
-- 書き込みは既にservice_role経由の/api/table-crudに限定済み(lock_down_
-- business_partners_writes.sql)。テーブルレベルGRANTのため、新規列に対する
-- 追加GRANTは不要(既存のGRANTが自動的にカバーする)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

ALTER TABLE public.business_partners
  ADD COLUMN IF NOT EXISTS department_phone text;

notify pgrst, 'reload schema';
