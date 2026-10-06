-- ============================================================
-- email_import_queue / email_import_queue_archive 停止中ロック: 実行前後の確認(読み取り専用)
-- SQL Editorで上から順に実行する。すべてSELECTのみ(データ・権限は変更しない)。
-- ロック実行の【前】に1〜9の結果を保存(スクリーンショット/CSV)しておくこと。
-- ロールバック(scripts/email_import_queue_pause_lock_rollback.sql)はこの結果を元に復元する。
-- 【設計のみ・未実行(2026-10-06)】
-- ============================================================

-- 1. RLSが有効か(email_import_queueはtrueのはず。archiveは作成SQLがRLSを複製しないためfalseの可能性あり)
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c
where c.oid in ('public.email_import_queue'::regclass, 'public.email_import_queue_archive'::regclass);

-- 2. 権限マトリクス(anon/authenticated/service_role × 4操作)
select t.tbl, r.role_name,
       has_table_privilege(r.role_name, t.tbl, 'SELECT') as can_select,
       has_table_privilege(r.role_name, t.tbl, 'INSERT') as can_insert,
       has_table_privilege(r.role_name, t.tbl, 'UPDATE') as can_update,
       has_table_privilege(r.role_name, t.tbl, 'DELETE') as can_delete
from (values ('public.email_import_queue'), ('public.email_import_queue_archive')) as t(tbl)
cross join (values ('anon'), ('authenticated'), ('service_role')) as r(role_name)
order by t.tbl, r.role_name;

-- 3. 付与されている権限の実体(PUBLIC宛ての付与が無いかも見る)
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('email_import_queue', 'email_import_queue_archive')
order by table_name, grantee, privilege_type;

-- 4. RLSポリシー一覧(policyname/cmd/roles/qual/with_checkをロールバック用に保存する)
select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('email_import_queue', 'email_import_queue_archive')
order by tablename, policyname;

-- 5. 件数と、取り込みが今も続いているか(max(created_at)と直近7日の件数)
select (select count(*) from public.email_import_queue) as queue_rows,
       (select count(*) from public.email_import_queue_archive) as archive_rows,
       (select max(created_at) from public.email_import_queue) as queue_last_created_at,
       (select count(*) from public.email_import_queue where created_at > now() - interval '7 days') as queue_created_last_7d;

-- 6. 制約(subject+sender+received_atの一意制約が存在するか。コード内コメントが前提にしている)
select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.email_import_queue'::regclass;

-- 7. 列名(コード・SQLファイルと一致するか。archive作成SQLでは
--    id, subject, body, sender, received_at, imported, created_at, ignored, postponed,
--    attachments, is_excluded, excluded_reason, html_body, archived_at(archiveのみ)。
--    updated_atはtable-crud.jsのコメントで言及があるが、SQLファイルでは確認できていない)
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name in ('email_import_queue', 'email_import_queue_archive')
order by table_name, ordinal_position;

-- 8. 迂回路: このテーブルを参照するビュー・関数・Realtime公開
select 'view' as kind, view_name as name from information_schema.view_table_usage
  where table_schema = 'public' and table_name in ('email_import_queue', 'email_import_queue_archive')
union all
select 'function', p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosrc ilike '%email_import_queue%'
union all
select 'realtime_publication', pubname || '.' || tablename from pg_publication_tables
  where schemaname = 'public' and tablename in ('email_import_queue', 'email_import_queue_archive');

-- 9. 添付ファイルのStorage(api/email-import.jsのSTORAGE_BUCKET='email-attachments')。
--    このロックの対象外だが、バケットが公開か・anon向けポリシーがあるかを確認しておく
select id, name, public from storage.buckets where id = 'email-attachments';
select policyname, roles, cmd, qual, with_check from pg_policies
where schemaname = 'storage' and tablename = 'objects' and (qual ilike '%email-attachments%' or with_check ilike '%email-attachments%');

-- ============================================================
-- ロック【後】の確認(同じ1〜4に加えて、以下。anonで読めないことを実際に確認する)
-- ============================================================
-- 期待: 1) email_import_queueのrls_enabled=true / 2) anon・authenticatedは全てfalse、service_roleは全てtrue
--       3) anon・authenticated・PUBLICの行が0件 / 4) anon向けポリシーが0件(archiveはポリシー0件)
-- anonで実際に拒否されること(各行を1文ずつ別々に実行。どれも permission denied が出れば成功):
--   begin; set local role anon; select count(*) from public.email_import_queue; rollback;
--   begin; set local role anon; insert into public.email_import_queue(subject,sender,received_at) values ('x','x',now()); rollback;
--   begin; set local role anon; select count(*) from public.email_import_queue_archive; rollback;
-- service_roleで通ること:
--   begin; set local role service_role; select count(*) from public.email_import_queue; rollback;
