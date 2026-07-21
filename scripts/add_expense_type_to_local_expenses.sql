-- local_expenses に expense_type(費用種類)列を追加する。
-- 予約詳細の「現地費用明細」保存時にアプリがこの列へ書き込むが、
-- 列が存在しないためPostgRESTのスキーマキャッシュに乗らずエラーになっていた。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.local_expenses
  add column if not exists expense_type text;

grant select, insert, update, delete on public.local_expenses to anon, authenticated, service_role;

notify pgrst, 'reload schema';
