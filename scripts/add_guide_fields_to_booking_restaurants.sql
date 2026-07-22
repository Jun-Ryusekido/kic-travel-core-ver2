-- レストランタブ(booking_restaurants)に、行ごとの担当ガイドを指定できるよう
-- guide_id(guidesマスタへのFK)・guide_name_freetext(自由入力用)列を追加する。
--
-- 2班体制のツアーで、同じレストランを別々のガイドが同行する場合等に、
-- ミールバウチャー発行時に行ごとに異なるガイド名・携帯番号を反映するための列。
-- 未入力(NULL/空文字)の場合、アプリ側は従来通り予約全体の担当ガイドを
-- フォールバックとして使うため、既存データには一切影響しない。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.booking_restaurants
  add column if not exists guide_id uuid references public.guides(id) on delete set null,
  add column if not exists guide_name_freetext text;

grant select, insert, update, delete on public.booking_restaurants to anon, authenticated, service_role;

notify pgrst, 'reload schema';
