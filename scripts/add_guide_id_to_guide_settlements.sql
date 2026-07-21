-- ガイド精算(guide_settlements)にguide_idカラムを追加する。
-- 過去分のレコードは氏名文字列(guide_name/guide_names)のみで、無理な自動突合は行わない
-- (guide_idはnullのまま)。今後新しく作成する精算リンクからのみ、担当ガイドタブ
-- (booking_guides)で選択したガイドのguide_idが自動でセットされるようになる。
--
-- guide_names列(1つの精算リンクに複数ガイドを紐付け可能なJSON配列 [{name,phone,guide_id}])側にも
-- 各ガイドのguide_idを個別に持たせるようアプリ側を変更する。guide_settlements.guide_id列は、
-- そのうち先頭(代表)のガイドのIDを入れておくことで、単純な「このガイドが担当した精算一覧」
-- というシンプルな検索・集計をguide_id 1列で行えるようにするためのもの
-- (複数ガイドの全件が必要な場合はguide_names配列側を見ること)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.guide_settlements
  add column if not exists guide_id uuid references public.guides(id) on delete set null;

create index if not exists guide_settlements_guide_id_idx on public.guide_settlements(guide_id);

grant select, insert, update, delete on public.guide_settlements to anon, authenticated, service_role;

notify pgrst, 'reload schema';
