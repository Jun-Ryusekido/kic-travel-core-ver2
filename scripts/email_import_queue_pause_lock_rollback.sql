-- ============================================================
-- email_import_queue 停止中ロックのロールバック【未実行(2026-10-06)】
--
-- 実DBの実測(JUNさん確認、2026-10-06)に合わせて、空欄なく埋めてある。precheckの出力を待たずに実行できる。
--
-- 復元するロック前の状態(実測):
--  ・ポリシー(roles={anon}の3本のみ):
--      "anon insert": FOR INSERT / with_check = true
--      "anon select": FOR SELECT / qual = true
--      "anon update": FOR UPDATE / qual = true / with_check = null
--  ・権限(aclexplodeによる実測。DBはPostgreSQL 17.6): anon = INSERT, MAINTAIN, SELECT / authenticated = MAINTAIN, SELECT
--      (MAINTAINはPG17で追加された権限。information_schema.role_table_grantsには出ない。
--       ロック前の状態に過不足なく戻すため復元する)
--      (UPDATEの権限は無い。TRUNCATE・REFERENCES・TRIGGERは先に剥奪済みのため復元しない。
--       anonのUPDATEポリシーは、権限が無いため実質効かない状態が「ロック前の姿」)
--  ・RLS: 有効のまま(ロックでも変えていない)
--
-- 触れないもの:
--  ・service_roleの権限(ロックでも変えていない)
--  ・email_import_queue_archive(実測どおり、anon権限なし・ポリシー0本のまま。ロックでも実質変えていない)
--
-- 冪等: 途中まで戻っていた状態からでも実行できる(権限は一度剥奪してから付け直し、ポリシーはdrop if exists→create)。
-- 実行後ガード: コミット前に、ポリシーと権限が上の実測と過不足なく一致することを検証し、
--   違えば例外で全体をロールバックする(ロック状態のまま変わらない)。
-- ============================================================
begin;

-- 権限: 一度anon/authenticatedの権限を空にしてから、実測どおりに付け直す(過不足を残さない)
revoke all on public.email_import_queue from anon;
revoke all on public.email_import_queue from authenticated;
grant select, insert, maintain on public.email_import_queue to anon;
grant select, maintain on public.email_import_queue to authenticated;

-- RLSは有効のまま(念のための冪等な再確認。ポリシーが全て無い状態でRLSを有効にすると全拒否になる点に注意:
-- 下でポリシーを作り直すまでは、このトランザクション内でも整合は取れていない。最後のガードで検証する)
alter table public.email_import_queue enable row level security;

-- ポリシー(実測の名前・ロール・操作・条件)
drop policy if exists "anon insert" on public.email_import_queue;
create policy "anon insert" on public.email_import_queue
  as permissive for insert to anon
  with check (true);

drop policy if exists "anon select" on public.email_import_queue;
create policy "anon select" on public.email_import_queue
  as permissive for select to anon
  using (true);

drop policy if exists "anon update" on public.email_import_queue;
create policy "anon update" on public.email_import_queue
  as permissive for update to anon
  using (true);

-- 実行後ガード: 実測と過不足なく一致しなければ例外 → 全体がロールバックされる
do $$
declare
  rls_on boolean;
  pol_total int;
  pol_match int;
  anon_priv text;
  auth_priv text;
  public_acl int;
begin
  select relrowsecurity into rls_on from pg_class where oid = 'public.email_import_queue'::regclass;
  if rls_on is not true then
    raise exception 'ロールバック後にRLSが無効です';
  end if;

  select count(*) into pol_total
  from pg_policies
  where schemaname = 'public' and tablename = 'email_import_queue';
  if pol_total <> 3 then
    raise exception 'ロールバック後のポリシーが3本ではありません(n=%)', pol_total;
  end if;

  select count(*) into pol_match
  from pg_policies
  where schemaname = 'public' and tablename = 'email_import_queue'
    and permissive = 'PERMISSIVE'
    and roles = array['anon']::name[]
    and (   (policyname = 'anon insert' and cmd = 'INSERT' and qual is null  and with_check = 'true')
         or (policyname = 'anon select' and cmd = 'SELECT' and qual = 'true' and with_check is null)
         or (policyname = 'anon update' and cmd = 'UPDATE' and qual = 'true' and with_check is null));
  if pol_match <> 3 then
    raise exception 'ロールバック後のポリシーが実測と一致しません(一致=%/3)', pol_match;
  end if;

  select string_agg(distinct a.privilege_type, ',' order by a.privilege_type) into anon_priv
  from pg_class c
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
  where c.oid = 'public.email_import_queue'::regclass and r.rolname = 'anon';
  if anon_priv is distinct from 'INSERT,MAINTAIN,SELECT' then
    raise exception 'ロールバック後のanon権限が実測(INSERT,MAINTAIN,SELECT)と違います: %', coalesce(anon_priv, '(なし)');
  end if;

  select string_agg(distinct a.privilege_type, ',' order by a.privilege_type) into auth_priv
  from pg_class c
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
  where c.oid = 'public.email_import_queue'::regclass and r.rolname = 'authenticated';
  if auth_priv is distinct from 'MAINTAIN,SELECT' then
    raise exception 'ロールバック後のauthenticated権限が実測(MAINTAIN,SELECT)と違います: %', coalesce(auth_priv, '(なし)');
  end if;

  select count(*) into public_acl
  from pg_class c
  cross join lateral aclexplode(c.relacl) a
  where c.oid = 'public.email_import_queue'::regclass and a.grantee = 0;
  if public_acl <> 0 then
    raise exception 'ロールバック後にPUBLIC宛ての権限があります(%件)', public_acl;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
