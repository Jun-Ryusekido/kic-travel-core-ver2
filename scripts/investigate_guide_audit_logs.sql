-- 読み取り専用(SELECTのみ。データは一切変更しない)。JUNがSupabase SQL Editorで実行する(1ブロック=1回)。
-- 列名はapi/table-crud.jsのwriteAuditLogs/doAuditHistoryで使われているものに合わせている:
--   audit_logs(table_name, record_id, action, changed_by, changed_at, before_data, after_data)
--   record_idはtext(String(recordId)で保存)。action = 'insert' | 'update' | 'delete'。
-- 注意: SQL Editorからの直接更新はaudit_logsに記録されない(記録はapi/table-crud.js経由の操作のみ)。
--       guidesがauditLog:trueになった以前の変更も記録されていない。

-- ============================================================
-- (a) audit_logsにguidesのマイナンバーが入っている行の「件数だけ」(値は出力しない)
--     plaintext_*: 平文で入っている行(今回のマスク導入前に保存されたもの)
--     redacted_*  : 今回のマスク導入後に保存された伏せ字の行
-- ============================================================
select
  action,
  count(*) filter (where nullif(before_data->>'my_number', '') is not null
                     and before_data->>'my_number' not like '(マイナンバー・値は非保存%') as plaintext_in_before,
  count(*) filter (where nullif(after_data->>'my_number', '') is not null
                     and after_data->>'my_number' not like '(マイナンバー・値は非保存%')  as plaintext_in_after,
  count(*) filter (where before_data->>'my_number' like '(マイナンバー・値は非保存%'
                      or after_data->>'my_number'  like '(マイナンバー・値は非保存%')   as redacted_rows,
  count(*) as total_guides_rows
from public.audit_logs
where table_name = 'guides'
group by action
order by action;

-- ============================================================
-- (b-1) 対象ガイドのid確認(氏名は guides.name / name_romaji のどちらかに入っている想定)
--       ※ここでもマイナンバー等の他の列は出さない
-- ============================================================
select id, name, name_romaji, is_deleted
from public.guides
where name ilike '%SAHDEV VIJAY KUMAR%' or name_romaji ilike '%SAHDEV VIJAY KUMAR%';

-- ============================================================
-- (b-2) そのガイドの bank_info の変更履歴(時系列)。操作日時・ユーザー・操作種別・変更前後のbank_infoのみ。
--       (b-1)で複数件出た場合も、ここでは氏名で絞って全件出す(record_idで見分けられる)。
--       insert/deleteは変更前または後がnullになる。update は bank_info が変わった行のみ。
-- ============================================================
select al.changed_at,
       al.changed_by,
       al.action,
       al.record_id,
       al.before_data->>'bank_info' as bank_info_before,
       al.after_data->>'bank_info'  as bank_info_after
from public.audit_logs al
where al.table_name = 'guides'
  and al.record_id in (select g.id::text
                       from public.guides g
                       where g.name ilike '%SAHDEV VIJAY KUMAR%' or g.name_romaji ilike '%SAHDEV VIJAY KUMAR%')
  and (al.action in ('insert', 'delete')
       or (al.before_data->>'bank_info') is distinct from (al.after_data->>'bank_info'))
order by al.changed_at asc;

-- ============================================================
-- (c) audit_logsのRLS・ポリシー・権限(読み取り専用の確認)
-- ============================================================
-- c-1) RLSが有効か
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'audit_logs';

-- c-2) ポリシー(0件なら、anon/authenticatedはRLSにより全行アクセス不可。service_roleはRLSをバイパス)
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'audit_logs';

-- c-3) anon / authenticated / service_role の実効権限
select r.rolname,
       has_table_privilege(r.rolname, 'public.audit_logs', 'SELECT') as can_select,
       has_table_privilege(r.rolname, 'public.audit_logs', 'INSERT') as can_insert,
       has_table_privilege(r.rolname, 'public.audit_logs', 'UPDATE') as can_update,
       has_table_privilege(r.rolname, 'public.audit_logs', 'DELETE') as can_delete
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;
