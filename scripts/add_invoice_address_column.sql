-- invoices.address列の追加。
--
-- 背景: Invoiceプレビュー画面の住所欄(#inv-address)はcontenteditableで手動編集
-- できるようになっていたが、id属性・保存対象(payload)への追加が漏れており、
-- 「保存しました」と表示されるのに実際はDBへ反映されず、再表示のたびに取引先マスタ
-- (agents.address)由来の既定値へ差し戻ってしまう不具合があった(2026-08、PR #77の
-- 実機検証で発見)。invoicesにはそもそもaddress列自体が存在しない(name_group/
-- itinerary/note/person_in_chargeはscripts/add_invoice_layout_columns.sqlで
-- 追加済みだが、住所欄だけ当時から列が用意されていなかった)。
--
-- このSQLでaddress列を追加する。列追加後は、このInvoice固有に手動編集された住所が
-- あればそれを優先表示し、無ければ従来通り取引先マスタ(agents.address)由来の
-- 既定値を表示する(index.html showInvoicePreview関数のdisplayAddress参照)。
--
-- 【実行タイミング】
-- コード側(index.html)は、この列がまだ存在しない状態でも他の保存項目
-- (Name/Group・Itinerary・Note・Person in Charge)には影響しないよう、住所欄の保存だけ
-- 独立したAPI呼び出しに分離してある(このリクエストだけがエラーになっても他は
-- 保存される)。とはいえ住所欄の保存自体を機能させるには、このSQLを実行しておく
-- 必要がある。実行順序に厳密な制約は無いが、コードデプロイ後になるべく早く
-- 実行することを推奨する。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.invoices
  add column if not exists address text default '';

-- 権限はscripts/add_invoice_layout_columns.sql実行時に付与済み(invoicesテーブル全体への
-- select/insert/update/deleteがanon/authenticated/service_roleに付与されている)ため、
-- この列だけの追加GRANTは不要。scripts/lock_down_invoices_writes.sql(未実行)適用後は
-- service_roleのみがinsert/update/deleteできる状態になる。

notify pgrst, 'reload schema';
