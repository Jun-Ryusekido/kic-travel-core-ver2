-- OCR学習機能の共通テーブル(learned_mappings)。
-- ユーザーの確定操作(メール対象外設定・カード明細確定・レシートカテゴリ確定)を
-- 「対象種別 + 正規化済み入力キー + 確定値」の形で蓄積し、次回以降の候補提示の
-- 優先順位付けにのみ使う(自動確定には使わない)。
--
-- 書き込みはservice_role専用(/api/table-crud経由)。anon/authenticatedにはSELECTのみ
-- 許可する(候補表示のための読み取りは各画面がanonキーで直接行うため)。
create table if not exists public.learned_mappings (
  id bigint generated always as identity primary key,
  category text not null check (category in ('email_sender','cc_merchant','receipt_merchant')),
  input_key text not null,
  confirmed_value text not null,
  confirmed_count int not null default 1,
  first_confirmed_at timestamptz not null default now(),
  last_confirmed_at timestamptz not null default now(),
  confirmed_by text,
  unique (category, input_key, confirmed_value)
);

alter table public.learned_mappings enable row level security;

-- 読み取りは全ロールに許可(RLSポリシー+GRANT)。書き込み系ポリシーは作らないため、
-- anon/authenticatedからのINSERT/UPDATE/DELETEはRLSで拒否される。
drop policy if exists learned_mappings_read on public.learned_mappings;
create policy learned_mappings_read on public.learned_mappings
  for select to anon, authenticated using (true);

grant select on public.learned_mappings to anon, authenticated;
grant select, insert, update, delete on public.learned_mappings to service_role;

notify pgrst, 'reload schema';
