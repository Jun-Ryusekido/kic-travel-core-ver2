-- access_logs(ログイン・ログアウト・ページ遷移・各種保存/削除操作の監査ログ)を、
-- 危険な状態から締める。
--
-- 【2026-08-14点検で判明した実態】
-- access_logsはRLS自体は有効(error_logsと違い無効ではない)だが、「Allow all」という
-- 無条件許可ポリシー(roles={public}, cmd=ALL, qual=true)が1つ設定されているため、
-- RLSが実質意味を成さず、SELECT/INSERT/UPDATE/DELETEすべてが誰でも自由に行える状態
-- (RLSが有効なのに"Allow all"ポリシーがある、というのはRLS無効と実害が同じ)。
--
-- アプリ内にaccess_logsを閲覧する画面はコード上どこにも存在しない(index.htmlを
-- 全文検索してもselectしている箇所は無く、書き込み専用: logAction()からの
-- sb.from('access_logs').insert(...)のみ、15箇所以上から呼ばれている)。
-- そのためコード修正は不要で、DB側のポリシーだけを締め直せばよい。
--
-- 【実行タイミング】
-- コード変更を伴わないため、他のlock_down_*.sqlのような「先にコードをデプロイしてから」
-- という前提は無い。ただし、実行前に必ず下記の確認クエリで現在のポリシー名を確認し、
-- 想定(policyname = 'Allow all')と一致しているかを見てからDROP POLICYを実行すること
-- (名前が異なる場合は、DROP POLICY文のポリシー名をその場で実際の名前に書き換えること)。
--
-- 【このSQLで変わること】
-- ・現在の無条件許可ポリシー("Allow all")をDROPする
-- ・anonロールのINSERTのみを許可する新しいポリシーを作成する(logAction()が
--   今もanonキーで直接INSERTしているため。authenticatedロールはこのアプリでは
--   Supabase Auth自体を使っておらず実際には使われていない)
-- ・SELECT/UPDATE/DELETE/TRUNCATE用の新しいポリシーは作らない → RLSが有効なテーブルは
--   「マッチするpermissiveポリシーが無いコマンドはデフォルト拒否」となるため、
--   テーブル側のGRANTの状態に関わらずこれらは自動的に拒否される
--
-- 【切り戻し】
-- 問題が起きた場合(例: logAction()のINSERTが失敗するようになった等)は、以下で
-- 元の無条件許可ポリシーを作り直せる:
--   create policy "Allow all" on public.access_logs for all to public using (true) with check (true);

-- ---- 実行前の確認(このSQLの本体を実行する前に、まず単独で実行して現状を確認すること) ----
-- 1) RLSの有効/無効(rowsecurityがtrueであることを確認。falseだった場合は
--    ポリシーを直しても無効なので、先に "alter table public.access_logs enable row level security;" が必要)
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'access_logs';

-- 2) 現在のポリシー一覧(policynameが下のDROP POLICY文と一致するか必ず確認すること)
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'access_logs';

-- 3) 参考: anon/authenticated/service_roleへのGRANT状況
--    (RLSが有効な限りこれらのGRANTの広さ自体は実害に直結しないが、記録として確認しておく)
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'access_logs'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- ---- 本体(上記1・2の確認結果を見て、ポリシー名が "Allow all" で間違いないことを確認してから実行すること) ----
drop policy if exists "Allow all" on public.access_logs;

create policy "access_logs_anon_insert_only" on public.access_logs
  for insert
  to anon
  with check (true);

-- ---- 実行後の確認(本体実行後、再度このクエリを流して意図通りになったか確認すること) ----
-- policyname="access_logs_anon_insert_only", cmd="INSERT", roles={anon} の1件のみが
-- 残っていることが期待値(SELECT/UPDATE/DELETE/TRUNCATE用のポリシーが無いため、
-- これらは全ロールに対してデフォルト拒否される)
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'access_logs';
