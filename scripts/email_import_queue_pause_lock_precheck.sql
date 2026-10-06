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
--    column_defaultも見る: 取り込みAPI(api/email-import.js)はcreated_atをINSERTに含めないため、
--    created_atはDB側のデフォルト値で入る。5の「最終取り込み日時」が信頼できるのは、created_atの
--    column_defaultが now() 等のとき(CREATE TABLEはリポジトリに無く、未確認)。
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name in ('email_import_queue', 'email_import_queue_archive')
order by table_name, ordinal_position;

-- 8. 迂回路(RLSとREVOKEをすり抜けてこのテーブルを読み書きできる経路)。8a・8b・8cをすべて実行する。
--    まだ一度も結果を確認できていない。ロックを実行する前に、結果を必ず確認すること。

-- 8a. publicの全ビュー・マテリアライズドビュー(推移的な依存も含む。ビュー→ビュー→テーブルも拾う)。
--     ビューは既定で「ビューの所有者の権限」で実行されるため、security_invoker=false のビューは、
--     テーブルのRLSもREVOKEも通らずに中身が読める。
--     【読み方】depends_on_queue=true かつ anon_can_select(またはauthenticated_can_select)=true かつ
--     security_invoker=false の行が1件でもあれば、迂回路あり。ロック前に別途対応する(ロックは実行しない)。
--     depends_on_queue=false の行は、このテーブルとは無関係(参考表示)。
with recursive v(view_oid) as (
  select rw.ev_class
  from pg_depend d
  join pg_rewrite rw on rw.oid = d.objid
  where d.classid = 'pg_rewrite'::regclass
    and d.refobjid in ('public.email_import_queue'::regclass, 'public.email_import_queue_archive'::regclass)
    and rw.ev_class <> d.refobjid
  union
  select rw.ev_class
  from v
  join pg_depend d on d.refobjid = v.view_oid and d.classid = 'pg_rewrite'::regclass
  join pg_rewrite rw on rw.oid = d.objid
  where rw.ev_class <> v.view_oid
)
select c.oid::regclass as view_name,
       case c.relkind when 'v' then 'view' when 'm' then 'matview' end as kind,
       pg_get_userbyid(c.relowner) as owner,
       exists (select 1 from unnest(coalesce(c.reloptions, '{}'::text[])) o
               where o in ('security_invoker=true', 'security_invoker=on')) as security_invoker,
       c.oid in (select view_oid from v) as depends_on_queue,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_can_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_can_select
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('v', 'm')
order by depends_on_queue desc, c.relname;

-- 8b. publicの全 SECURITY DEFINER 関数(関数の所有者の権限で実行され、RLSを迂回し得る)。
--     関数の中身がこのテーブルを名指ししていなくても(動的SQL等)、定義者権限の関数はすべて列挙する。
--     【読み方】anon_can_execute(またはauthenticated_can_execute)=true の関数が、
--     mentions_queue=true なら迂回路あり(/rpc/<関数名> でanonから呼べる)。
--     mentions_queue=false でも、中身(select pg_get_functiondef('<function_signature>'::regprocedure);)を
--     確認し、テーブル名を文字列で組み立てて実行していないかを見る。
--     config に search_path が無い定義者関数は、それ自体が別のリスクなので別途報告する。
select p.oid::regprocedure as function_signature,
       pg_get_userbyid(p.proowner) as owner,
       p.proconfig as config,
       p.prosrc ilike '%email_import_queue%' as mentions_queue,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
order by anon_can_execute desc, mentions_queue desc, p.proname, p.oid;

-- 8c. Realtime公開(publicationにテーブルが入っていると、変更内容が配信され得る)
--     【読み方】0件ならOK。1件以上あれば、anonが購読できるかを別途確認する。
select pubname, schemaname, tablename
from pg_publication_tables
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
