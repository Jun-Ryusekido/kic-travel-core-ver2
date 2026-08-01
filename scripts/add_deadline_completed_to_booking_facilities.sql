-- booking_facilities に、対応期限のToDoチェック機能で使うdeadline_completed(完了フラグ)/
-- deadline_completed_at(完了日時)列を追加する。
-- ダッシュボードのToDoリストでチェックを入れて完了扱いにする際にアプリがこれらの列へ
-- 書き込むが、列が存在しないためPostgRESTのスキーマキャッシュに乗らずエラーになっていた。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

alter table public.booking_facilities
  add column if not exists deadline_completed boolean not null default false,
  add column if not exists deadline_completed_at timestamptz;

grant select, insert, update, delete on public.booking_facilities to anon, authenticated, service_role;

notify pgrst, 'reload schema';
