-- 実手配の仕入明細(booking_costs)における支払方法の再設計に伴うスキーマ変更。
--
-- 背景: 現状「法人カード」「個人カード」の区別はmemo欄への手打ち文字列でしか
-- 運用されておらず(payment_method列は常にNULL)、クレジットカード明細の自動
-- マッチング(findCcMatchCandidates)がこの非構造データに依存して表記ゆれに弱い上、
-- 個人立替の返金漏れを追跡する仕組みが一切無かった。
--
-- 1) card_holder: 支払方法が「クレジットカード(法人)」「クレジットカード(個人・要精算)」の
--    場合の名義人(app_users.nameの固定リストから選択する想定。マスタは新設せず
--    app_usersを流用する)。credit_card_statements.card_holderとの突合に使う。
-- 2) personal_reimbursement_status: 「クレジットカード(個人・要精算)」の場合のみ使う
--    返金状況('未精算'/'精算済み')。それ以外の支払方法では常にnull。
-- 3) personal_reimbursed_at: 精算済みに変更した日時。
alter table public.booking_costs add column if not exists card_holder text;
alter table public.booking_costs add column if not exists personal_reimbursement_status text;
alter table public.booking_costs add column if not exists personal_reimbursed_at timestamptz;

notify pgrst, 'reload schema';
