-- Invoice番号・検索キーを状態に依存しない固定設計にするための is_consolidated 列追加。
--
-- 背景: 従来のInvoice番号(invoice_no)は「請求先が何個あるか」という状態に依存して
-- 決まっていたため(単一なら識別子なし、複数ならTC/SO等の識別子付き)、予約の途中で
-- 請求先構成が変わると番号ごと変わってしまい、既存Invoiceを見失って重複INSERTされる
-- 不具合が発生した(REF#967でINV-967とINV-967-TCが併存する形で発覚)。
--
-- 対応: 「合算Invoice(そのbooking_id全体の売上合計)」と「請求先ごとの個別Invoice」を
-- 明示的な列で区別し、検索・更新対象の判定をinvoice_no文字列ではなく
-- booking_id + is_consolidated (+ 個別の場合はagent_name) という、請求先構成が
-- 変わっても揺るがない情報で行うようにする。
--
-- agent_nameをNULLにする案も検討したが、agent_nameが未設定のInvoiceは既存の入金消込
-- ロジック(F12対応、saveBookingDetail内)で「請求先を一意に特定できないため自動判定を
-- スキップし要手動確認とする」という別の意味を既に持っており衝突するため、新規の
-- 専用列で区別する方式を採用する。
--
-- 列追加直後は既存行が全てis_consolidated=false(個別Invoice)になるが、これは正しい
-- (過去に発行された単一請求先の予約のInvoiceは、内容としては個別=合算のため実害はない)。
-- 合算Invoiceは、今後の個別Invoice発行時の自動追従、または「合算発行」ボタンにより、
-- 必要になったタイミングで遅延生成される。
--
-- 部分ユニークインデックスにより、1つのbooking_idに対して合算Invoiceが2件以上
-- できてしまうことをDB側でも防ぐ(今回の孤立バグの再発防止)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.invoices add column if not exists is_consolidated boolean not null default false;

create unique index if not exists invoices_one_consolidated_per_booking
  on public.invoices(booking_id) where is_consolidated;

notify pgrst, 'reload schema';
