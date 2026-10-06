-- ============================================================
-- email_import_queue(メール受信箱)停止中のDB側ロック【未実行(2026-10-06)】
--
-- 前提・実行条件は SESSION_NOTES.md「メール受信箱の停止中ロック設計」のチェックリストをすべて満たしてから。
-- 実行前に scripts/email_import_queue_pause_lock_precheck.sql の1〜9(8a/8b/8cを含む)の結果を保存すること。
--
-- このSQLで変わること:
--  ・email_import_queue / email_import_queue_archive: anon・authenticatedの全権限をREVOKE
--  ・email_import_queue: anon向けRLSポリシー3本("anon insert" / "anon select" / "anon update")をDROP(RLSは有効のまま)
--  ・service_roleにはGRANTを明示(過去にGRANT漏れで止まった経緯があるため。service_roleでの
--    api/email-import.js・api/table-crud.js・バックアップ・scripts/*.jsの経路は維持される)
--  ・email_import_queue_archiveは、実測(RLS有効・anon権限なし・ポリシー0本)のとおりなら、
--    下の処理はすべて何も変えない(冪等な再確認のみ)
--
-- 実行前ガード(実DBの実測と一致しなければ例外で止まり、何も変わらない):
--  ・email_import_queueのRLSが有効
--  ・ポリシーがテーブル全体でちょうど3本で、名前・操作・ロール・条件が次と完全に一致
--      "anon insert": FOR INSERT TO anon / with_check = true
--      "anon select": FOR SELECT TO anon / qual = true
--      "anon update": FOR UPDATE TO anon / qual = true / with_check = null
--  ・権限が anon={INSERT,MAINTAIN,SELECT}、authenticated={MAINTAIN,SELECT}、PUBLIC宛てなし、列単位の権限なし
--    (ロールバックSQLがこの状態へ過不足なく戻せることを保証するため。
--     MAINTAINはPostgreSQL 17で追加された権限(VACUUM/ANALYZE/REINDEX等)。information_schema.role_table_grantsには
--     出ないため、2026-10-06の1回目の実行はこのガードで止まった(何も変わっていない)。実測はprecheckのC-1(aclexplode)による。
--     DBはPostgreSQL 17.6)
-- 実行後ガード: コミット前に最終状態を検証し、違えば例外で全体をロールバックする。
-- ============================================================
begin;

do $$
declare
  rls_on boolean;
  pol_total int;
  pol_match int;
  anon_priv text;
  auth_priv text;
  public_acl int;
  col_acl int;
begin
  select relrowsecurity into rls_on from pg_class where oid = 'public.email_import_queue'::regclass;
  if rls_on is not true then
    raise exception 'email_import_queueのRLSが無効です。想定外のため中止します';
  end if;

  -- ポリシーはロール問わずテーブル全体でちょうど3本
  select count(*) into pol_total
  from pg_policies
  where schemaname = 'public' and tablename = 'email_import_queue';
  if pol_total <> 3 then
    raise exception 'email_import_queueのポリシーが3本ではありません(n=%)。想定外のため中止します', pol_total;
  end if;

  -- その3本が、名前・操作・ロール・条件まで実測と完全一致
  select count(*) into pol_match
  from pg_policies
  where schemaname = 'public' and tablename = 'email_import_queue'
    and permissive = 'PERMISSIVE'
    and roles = array['anon']::name[]
    and (   (policyname = 'anon insert' and cmd = 'INSERT' and qual is null  and with_check = 'true')
         or (policyname = 'anon select' and cmd = 'SELECT' and qual = 'true' and with_check is null)
         or (policyname = 'anon update' and cmd = 'UPDATE' and qual = 'true' and with_check is null));
  if pol_match <> 3 then
    raise exception 'ポリシーの名前・操作・ロール・条件が想定("anon insert"/"anon select"/"anon update"の3本)と一致しません(一致=%/3)。想定外のため中止します', pol_match;
  end if;

  -- テーブル権限(ロールバックSQLの復元内容と一致していること)
  select string_agg(distinct a.privilege_type, ',' order by a.privilege_type) into anon_priv
  from pg_class c
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
  where c.oid = 'public.email_import_queue'::regclass and r.rolname = 'anon';
  if anon_priv is distinct from 'INSERT,MAINTAIN,SELECT' then
    raise exception 'anonの権限が想定(INSERT,MAINTAIN,SELECT)と違います: %。想定外のため中止します', coalesce(anon_priv, '(なし)');
  end if;

  select string_agg(distinct a.privilege_type, ',' order by a.privilege_type) into auth_priv
  from pg_class c
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
  where c.oid = 'public.email_import_queue'::regclass and r.rolname = 'authenticated';
  if auth_priv is distinct from 'MAINTAIN,SELECT' then
    raise exception 'authenticatedの権限が想定(MAINTAIN,SELECT)と違います: %。想定外のため中止します', coalesce(auth_priv, '(なし)');
  end if;

  select count(*) into public_acl
  from pg_class c
  cross join lateral aclexplode(c.relacl) a
  where c.oid = 'public.email_import_queue'::regclass and a.grantee = 0;
  if public_acl <> 0 then
    raise exception 'PUBLIC宛ての権限が付いています(%件)。想定外のため中止します', public_acl;
  end if;

  select count(*) into col_acl
  from pg_attribute
  where attrelid = 'public.email_import_queue'::regclass and attnum > 0 and not attisdropped and attacl is not null;
  if col_acl <> 0 then
    raise exception '列単位の権限が付いています(%列)。想定外のため中止します', col_acl;
  end if;

  -- archiveも実測どおり(anon/authenticated/PUBLIC宛ての権限が無く、ポリシーも0本)であること
  if exists (select 1 from pg_class c cross join lateral aclexplode(c.relacl) a
             left join pg_roles r on r.oid = a.grantee
             where c.oid = 'public.email_import_queue_archive'::regclass
               and (a.grantee = 0 or r.rolname in ('anon', 'authenticated')))
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'email_import_queue_archive') then
    raise exception 'email_import_queue_archiveに、anon/authenticated/PUBLIC宛ての権限またはポリシーがあります。想定外のため中止します';
  end if;

  -- ガードを通過した場合のみ、実測した3本を名前で落とす
  drop policy "anon insert" on public.email_import_queue;
  drop policy "anon select" on public.email_import_queue;
  drop policy "anon update" on public.email_import_queue;
end $$;

-- email_import_queue
revoke all on public.email_import_queue from anon;
revoke all on public.email_import_queue from authenticated;
grant select, insert, update, delete on public.email_import_queue to service_role;
alter table public.email_import_queue enable row level security;

-- email_import_queue_archive(実測: RLS有効・anon権限なし・ポリシー0本のため、以下は何も変えない。
-- 状態が想定と違っていた場合に備えた冪等な再確認。ポリシーは作らない)
revoke all on public.email_import_queue_archive from anon;
revoke all on public.email_import_queue_archive from authenticated;
grant select, insert, update, delete on public.email_import_queue_archive to service_role;
alter table public.email_import_queue_archive enable row level security;

-- 実行後ガード: 最終状態が期待どおりでなければ例外 → 全体がロールバックされる(何も変わらない)
do $$
declare
  leftover text;
  missing text;
  pol_left int;
  rls_off text;
begin
  -- anon/authenticated/PUBLIC宛ての権限が、権限の種類を問わず1つも残っていないこと(MAINTAIN等も含む。列単位も含む)
  select string_agg(distinct c.relname || ':' || coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ', ') into leftover
  from pg_class c
  cross join lateral aclexplode(c.relacl) a
  left join pg_roles r on r.oid = a.grantee
  where c.oid in ('public.email_import_queue'::regclass, 'public.email_import_queue_archive'::regclass)
    and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'));
  if leftover is not null then
    raise exception 'ロック後もanon/authenticated/PUBLICの権限が残っています: %', leftover;
  end if;

  select string_agg(distinct c.relname || '.' || att.attname, ', ') into leftover
  from pg_class c
  join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped and att.attacl is not null
  where c.oid in ('public.email_import_queue'::regclass, 'public.email_import_queue_archive'::regclass);
  if leftover is not null then
    raise exception 'ロック後も列単位の権限が残っています: %', leftover;
  end if;

  -- service_roleは4操作とも通ること
  select string_agg(t.tbl || ':' || p.priv, ', ') into missing
  from (values ('public.email_import_queue'), ('public.email_import_queue_archive')) as t(tbl)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv)
  where not has_table_privilege('service_role', t.tbl, p.priv);
  if missing is not null then
    raise exception 'service_roleの権限が不足しています: %', missing;
  end if;

  -- anon/authenticated/PUBLIC宛てのポリシーが両テーブルに無いこと
  select count(*) into pol_left
  from pg_policies
  where schemaname = 'public' and tablename in ('email_import_queue', 'email_import_queue_archive')
    and roles && array['anon', 'authenticated', 'public']::name[];
  if pol_left <> 0 then
    raise exception 'anon/authenticated/public向けのポリシーが残っています(%本)', pol_left;
  end if;

  -- RLSが両テーブルとも有効であること
  select string_agg(c.relname, ', ') into rls_off
  from pg_class c
  where c.oid in ('public.email_import_queue'::regclass, 'public.email_import_queue_archive'::regclass)
    and c.relrowsecurity is not true;
  if rls_off is not null then
    raise exception 'RLSが無効のテーブルがあります: %', rls_off;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
