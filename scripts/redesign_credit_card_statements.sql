-- クレジットカード明細機能の再設計(フェーズ1)に伴うスキーマ変更。
--
-- 1) memo: ツアーコード以外の手書きメモ(「交通費」「倉庫代」等)をそのまま保存する列。
-- 2) excluded_reason: match_status='対象外'(紐付け不要と判断した明細)にした際の任意メモ。
-- 3) created_at: 一覧で「未紐付けのまま何日放置されているか」を判定するための取り込み日時。
--    transaction_date(利用日=購入日)はこの用途には使えない(購入日と読み取り登録日は
--    通常大きくズレるため)。
-- 4) created_by/updated_by: 監査ログ機能(audit_logs)の前提整備。api/table-crud.jsの
--    stampIdentity:trueにより、以後の書き込みで検証済みセッションのemailが自動スタンプされる
--    (booking_costs等、既存のstampIdentity対象テーブルと同じ方式)。
--
-- 【重要】このリリースでは、書き込み経路をanonキー直接からservice_role専用API
-- (api/table-crud.js)へ切り替えるが、無停止移行のためanonのINSERT/UPDATE/DELETE権限は
-- 今回は剥奪しない(下のgrantは変更前と同じ内容のまま維持する)。table-crud.js経由への
-- 切替が本番で安定稼働することを確認した後、別途「フェーズB」としてREVOKEを実施すること
-- (bookings/booking_hotels等、他テーブルのセキュリティ移行時と同じ二段階の進め方)。
alter table public.credit_card_statements add column if not exists memo text;
alter table public.credit_card_statements add column if not exists excluded_reason text;
alter table public.credit_card_statements add column if not exists created_at timestamptz not null default now();
alter table public.credit_card_statements add column if not exists created_by text;
alter table public.credit_card_statements add column if not exists updated_by text;

notify pgrst, 'reload schema';
