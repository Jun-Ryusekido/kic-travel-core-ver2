-- アプリ全体のエラー可視化機能用の error_logs テーブル作成DDL。
-- アプリ内の logError(context, error) から1件ずつinsertされ、管理者のみが
-- 「エラーログ」ページで直近100件を閲覧できる。
-- Supabaseダッシュボードの SQL Editor で実行すること。
--
-- 注意: RLS無効化だけではPostgREST(anon/authenticatedキー)からテーブルが
-- 完全に非表示になる(エラーではなく404 PGRST205になる)ため、GRANTと
-- スキーマキャッシュのリロードを必ずセットで行う(過去にGRANT漏れで
-- arrangement_documentsが見えなくなる問題を起こしている)。

create table if not exists public.error_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_email text default '',
  page_or_function text default '',
  error_message text default '',
  error_detail text default '',
  user_agent text default ''
);

create index if not exists error_logs_created_at_idx on public.error_logs(created_at desc);

alter table public.error_logs disable row level security;

grant select, insert, update, delete on public.error_logs to anon, authenticated, service_role;

notify pgrst, 'reload schema';
