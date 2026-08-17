-- カード名義人マスタ(card_holders)の新設。
--
-- 背景: クレジットカード明細画面・予約詳細(仕入明細タブ)の「名義人を選択」欄が、
-- 現状app_users(スタッフ一覧)全アカウントをそのまま選択肢にしている。実際に
-- カードを保有しているのは一部のスタッフのみ(RAJESH KUMAR / JUN RYUSEKIDO /
-- IMANAKA TAKAO / HEMA PURWAHAの4名)のため、app_usersとは独立したカード名義人
-- 専用のマスタを新設し、実際にカードを保有する人物のみを候補にする(index.htmlの
-- fetchCcCardHolderStaff切替と対になる変更)。
--
-- なお、app_usersへのanonキーからの直接SELECTは既に廃止済み(index.htmlの
-- doLogin/loadAccounts参照、/api/login・/api/list-users経由に統一済み)のため、
-- 従来のfetchCcCardHolderStaff()(sb.from('app_users').select('name'))は既に
-- エラーとなり、名義人の選択肢が空のまま表示されていた可能性が高い。今回の
-- 切替はこの不具合の修正も兼ねる。
--
-- 権限方針はlearned_mappingsと同じ「RLS有効化+読み取り専用ポリシーのみ作成」
-- (今日のerror_logs/access_logsの教訓を踏まえ、最初から安全な権限で作る)。
-- 読み取り専用ポリシーしか無いため、anon/authenticatedからのINSERT/UPDATE/DELETEは
-- RLSでも拒否される(GRANTを絞るだけの単純な権限管理より一段安全)。
-- 新規追加・無効化(is_active=falseへの更新。物理削除はしない)は/api/table-crud経由の
-- service_role操作のみとし、サーバー側でリクエスト元のセッションがadmin@kictravel.jpで
-- あることも確認する(index.htmlのCARD_HOLDER_ADMIN_EMAILS/isCardHolderAdmin()、
-- api/table-crud.jsのcard_holders専用チェック参照)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

create table if not exists public.card_holders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.card_holders enable row level security;

-- 読み取りは全ロールに許可(RLSポリシー+GRANT)。書き込み系ポリシーは作らないため、
-- anon/authenticatedからのINSERT/UPDATE/DELETEはRLSで拒否される。
drop policy if exists card_holders_read on public.card_holders;
create policy card_holders_read on public.card_holders
  for select to anon, authenticated using (true);

grant select on public.card_holders to anon, authenticated;
grant select, insert, update, delete on public.card_holders to service_role;

-- 初期データ: 実際にカードを保有している4名のみ
insert into public.card_holders (name, is_active) values
  ('RAJESH KUMAR', true),
  ('JUN RYUSEKIDO', true),
  ('IMANAKA TAKAO', true),
  ('HEMA PURWAHA', true);

notify pgrst, 'reload schema';
