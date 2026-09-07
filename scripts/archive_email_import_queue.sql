-- ============================================================
-- email_import_queue: 解決済み(imported/ignored/is_excludedのいずれかtrue)かつ
-- created_atが30日以上前の行を email_import_queue_archive へ退避する(2026-09-07)。
--
-- 背景: email_import_queueは1万件超・1行あたりの本文が大きく、日次バックアップの
-- egress(データ転送量)の大半を占めていた。まだ対応待ち(pending)の行は業務上
-- 必要な可能性があるため対象外とし、既に処理が完了して用済みの行だけを動かす。
--
-- 実行済み(2026-09-07): 対象4,010件をアーカイブへ移動。
-- 実行後の件数: email_import_queue 7,563件 / email_import_queue_archive 4,010件。
-- backup_supabase.ps1・backup_supabase_daily.ps1 の対象テーブルからは
-- email_import_queue_archive を意図的に除外している(PR #162)。
-- ============================================================

-- 1. アーカイブテーブル作成(email_import_queueと同じ列構成・制約・インデックスを複製)
create table if not exists public.email_import_queue_archive (
  like public.email_import_queue including all
);

-- いつ退避したかを記録する列を追加
alter table public.email_import_queue_archive
  add column if not exists archived_at timestamptz not null default now();

-- 権限: 新設テーブルのため最初からservice_role専用とする(partner_merge_pending等と
-- 同じ方針)。バックアップ対象からも意図的に除外するテーブルであり、アプリのメール
-- 受信箱一覧(imported=false かつ ignored=false のみを表示)からも参照しないため、
-- anon/authenticatedへの権限は不要。
revoke all on public.email_import_queue_archive from anon, authenticated;
grant select, insert, update, delete on public.email_import_queue_archive to service_role;

notify pgrst, 'reload schema';

-- 2. 実行直前の対象件数の確認(念のため、想定の4,010件前後であることを確認)
select count(*) as target_count
from public.email_import_queue
where (imported = true or ignored = true or is_excluded = true)
  and created_at < now() - interval '30 days';

-- 3. 対象行をアーカイブへコピー(既に同じidが入っていれば何もしない=再実行安全)
insert into public.email_import_queue_archive (
  id, subject, body, sender, received_at, imported, created_at, ignored,
  postponed, attachments, is_excluded, excluded_reason, html_body, archived_at
)
select
  id, subject, body, sender, received_at, imported, created_at, ignored,
  postponed, attachments, is_excluded, excluded_reason, html_body, now()
from public.email_import_queue
where (imported = true or ignored = true or is_excluded = true)
  and created_at < now() - interval '30 days'
on conflict (id) do nothing;

-- 4. コピー件数の確認(2.の件数と一致するはず)
select count(*) as archived_count from public.email_import_queue_archive;

-- 5. アーカイブへの移動が確認できた行だけを元テーブルから削除
--    (id in (...)で、実際にアーカイブに存在する行のみを削除対象にする安全策)
delete from public.email_import_queue
where (imported = true or ignored = true or is_excluded = true)
  and created_at < now() - interval '30 days'
  and id in (select id from public.email_import_queue_archive);

-- 6. 削除後の最終確認(元テーブルの残件数、対象条件に該当する行が0件になっていること)
select count(*) as remaining_total from public.email_import_queue;
select count(*) as remaining_target_condition
from public.email_import_queue
where (imported = true or ignored = true or is_excluded = true)
  and created_at < now() - interval '30 days';
