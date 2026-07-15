-- booking_guides テーブル作成用DDL。
-- このリポジトリのコードからは実行できない（publishable/anonキーではDDL権限がないため）。
-- Supabaseダッシュボードの SQL Editor で、管理者権限のセッションから手動実行すること。
--
-- 設計方針:
--   - booking_buses（1つのbooking_idに対して複数行を持てる明細テーブル）を参考にしている。
--   - ガイドは guides マスタへの外部キー(guide_id)で紐付けるのを基本とするが、
--     マスタに存在しない/登録が間に合わないガイドのために guide_name_freetext
--     （自由入力の氏名テキストのみ）でも保存できるようにしている。
--     guide_id と guide_name_freetext は排他利用（アプリ側でどちらか一方のみ設定する）。
--   - 1件のツアー(booking_id)に対して複数のガイド行（人数の多いツアーでの複数名アサイン）
--     を保持できる。
--   - RLSは、このアプリがSupabase Authを使わず独自のapp_usersテーブルでログイン管理しており
--     （auth.uid()は常に空）、booking_buses等の既存の運用テーブルと同様にpublishable
--     （anon）キー1本で全操作を行っているため、他の運用テーブルに合わせて無効化する。

create table if not exists public.booking_guides (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  guide_id uuid references public.guides(id) on delete set null,
  guide_name_freetext text,
  start_date date,
  end_date date,
  status text not null default '回答待ち',
  memo text default '',
  created_at timestamptz not null default now()
);

create index if not exists booking_guides_booking_id_idx on public.booking_guides(booking_id);
create index if not exists booking_guides_guide_id_idx on public.booking_guides(guide_id);

-- 他の運用テーブル（booking_buses等）と同様、RLSは無効化する。
-- 既にRLSを有効かつ別ポリシーで運用している場合は、このALTER文は実行せず、
-- 他テーブルと同じポリシーを個別に付与すること。
alter table public.booking_guides disable row level security;
