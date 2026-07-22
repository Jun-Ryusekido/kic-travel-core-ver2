-- 新幹線(bullet_train_arrangements)・ガイド(booking_guides)タブに、
-- 事前の概算仮払い額として扱うamount(金額)列を追加する。
--
-- 注意: booking_guides.amountは、既存のguide_settlements/guide_settlement_itemsに
-- よるガイド精算(daily_fee=0の既存仕様含む)とは全く別の値であり、その計算方法には
-- 一切影響しない。あくまで担当ガイドタブ側で入力する事前の概算仮払い額。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.bullet_train_arrangements
  add column if not exists amount numeric default 0;
alter table public.booking_guides
  add column if not exists amount numeric default 0;

grant select, insert, update, delete on public.bullet_train_arrangements to anon, authenticated, service_role;
grant select, insert, update, delete on public.booking_guides to anon, authenticated, service_role;

notify pgrst, 'reload schema';
