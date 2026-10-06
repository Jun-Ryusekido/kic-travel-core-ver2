-- ============================================================
-- email_import_queue(メール受信箱)停止中のDB側ロック【設計のみ・未実行(2026-10-06)】
--
-- 前提・実行条件は SESSION_NOTES.md「メール受信箱の停止中ロック設計」のチェックリストをすべて満たしてから。
-- 実行前に scripts/email_import_queue_pause_lock_precheck.sql の1〜9の結果を保存すること。
--
-- このSQLで変わること:
--  ・email_import_queue / email_import_queue_archive: anon・authenticatedの全権限をREVOKE
--  ・email_import_queue: anon向けRLSポリシー(INSERT/SELECT/UPDATEの3本)をDROP(RLSは有効のまま)
--  ・service_roleにはGRANTを明示(過去にGRANT漏れで止まった経緯があるため。service_roleでの
--    api/email-import.js・api/table-crud.js・バックアップ・scripts/*.jsの経路は維持される)
--
-- ポリシー名はリポジトリ内のSQLファイルでは確認できなかったため、名前を直書きせず、
-- 「anon/publicが対象のポリシーがちょうど3本(INSERT/SELECT/UPDATE)であること」を確認してから
-- 該当ポリシーを落とす。想定と違えば例外で全体がロールバックされる(何も変わらない)。
-- ============================================================
begin;

do $$
declare
  rls_on boolean;
  n int;
  cmds text[];
  p record;
begin
  select relrowsecurity into rls_on from pg_class where oid = 'public.email_import_queue'::regclass;
  if rls_on is not true then
    raise exception 'email_import_queueのRLSが無効です。想定外のため中止します';
  end if;

  select count(*), array_agg(cmd order by cmd) into n, cmds
  from pg_policies
  where schemaname = 'public' and tablename = 'email_import_queue'
    and roles && array['anon', 'public']::name[];
  if n <> 3 or cmds <> array['INSERT', 'SELECT', 'UPDATE'] then
    raise exception 'anon/public向けポリシーが想定(INSERT/SELECT/UPDATEの3本)と違います: n=%, cmds=%', n, cmds;
  end if;

  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'email_import_queue'
      and roles && array['anon', 'public']::name[]
  loop
    execute format('drop policy %I on public.email_import_queue', p.policyname);
  end loop;
end $$;

-- email_import_queue
revoke all on public.email_import_queue from anon;
revoke all on public.email_import_queue from authenticated;
grant select, insert, update, delete on public.email_import_queue to service_role;
alter table public.email_import_queue enable row level security;

-- email_import_queue_archive(作成時にanon/authenticatedはREVOKE済みのはずだが、冪等に再確認。
-- like ... including allはRLSを複製しないため、RLSも明示的に有効化する。ポリシーは作らない)
revoke all on public.email_import_queue_archive from anon;
revoke all on public.email_import_queue_archive from authenticated;
grant select, insert, update, delete on public.email_import_queue_archive to service_role;
alter table public.email_import_queue_archive enable row level security;

notify pgrst, 'reload schema';

commit;
