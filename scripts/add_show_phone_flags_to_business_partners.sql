-- 取引先マスタ(business_partners)の電話番号3種について、手配一覧表
-- (Arrangement Summary)に表示するかどうかをそれぞれチェックボックスで
-- 手動選択できるようにする。
--
-- 従来の「担当者直通>部署直通>会社代表番号」の固定優先順位による自動選択は、
-- 取引先の種類・実情(ホテルは代表番号を出したい、バス会社は担当者・会社の
-- 両方を出したい等)に合わないため廃止し、この3列のチェックが入っている
-- 電話番号を(複数可)表示する方式に変更する。
--
-- デフォルトはfalse(未チェック)。既存の取引先データは全てfalseとなるため、
-- 運用者が手配一覧表に電話番号を出したい取引先について、後からチェックを
-- 入れる想定(自動フォールバックはしない)。
--
-- 書き込みは既にservice_role経由の/api/table-crudに限定済み(lock_down_
-- business_partners_writes.sql)。テーブルレベルGRANTのため、新規列に対する
-- 追加GRANTは不要(既存のGRANTが自動的にカバーする)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

ALTER TABLE public.business_partners
  ADD COLUMN IF NOT EXISTS show_contact_phone boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_department_phone boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_company_phone boolean NOT NULL DEFAULT false;

notify pgrst, 'reload schema';
