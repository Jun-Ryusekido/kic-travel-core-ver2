-- セキュリティ中長期対応: tour_arrangements/tour_arrangement_days/bullet_train_arrangements/
-- arrangement_documentsの4テーブルへの書き込みをservice_role経由に限定する。
--
-- 背景: 4テーブルとも、tour_arrangement_headers等似た名前の別テーブルとの取り違えで
-- service_role移行対象から漏れ、anonキーからのinsert/update/delete/upsertが直接可能な
-- 状態のまま放置されていた(2026-08点検で判明)。invoices等と同じ手順(service_role API化→
-- フロント切替→検証→REVOKE)で対応する。
--
-- 書き込み経路は全てapi/table-crud.js(service_role key使用)経由に移行済み
-- (index.htmlのtourArrangementsApiCall/tourArrangementDaysApiCall/
-- bulletTrainArrangementsApiCall/arrangementDocumentsApiCall、
-- api/table-crud.jsのTABLE_CONFIG参照)。
--
-- 読み取り(select)は今回変更しない。手配書一覧・新幹線手配一覧・ガイド別手配書表示等、
-- 既存の閲覧系機能は従来通りanonキー+RLS無効のまま動作する。
--
-- 【実行タイミング】
-- 必ず、上記の書き込み経路が全てservice_role経由になっているコード(現在の本番)を
-- デプロイした状態で、実際に手配書登録・編集・削除、新幹線予約登録・編集・削除・CSV取込、
-- ガイド別手配書の自動作成・共通ドラフト取り込み・編集保存が正常に動作することを
-- 確認してから実行すること(先にこのSQLを実行すると、古いJSを開いたままのタブからの
-- 操作が失敗する)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

-- ---- 実行前の確認(このSQLの本体を実行する前に、まず単独で実行して現状を確認すること) ----

-- 1) RLSの有効/無効(rowsecurityがtrueなら有効)
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('tour_arrangements', 'tour_arrangement_days', 'bullet_train_arrangements', 'arrangement_documents')
order by tablename;

-- 2) anon/authenticated/service_roleへのGRANT状況
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('tour_arrangements', 'tour_arrangement_days', 'bullet_train_arrangements', 'arrangement_documents')
  and grantee in ('anon', 'authenticated', 'service_role')
order by table_name, grantee, privilege_type;

-- 3) 4テーブルに設定されているRLSポリシー一覧。bullet_train_arrangementsには「anon全権限」の
--    ポリシーが残存していることが判明済みのため、ここで実際のポリシー名を確認すること。
--    他3テーブルについても、意味を失った・矛盾したポリシー(RLS無効なのに残っているもの、
--    anon/authenticatedに書き込みを許可する内容のもの等)が無いか確認すること。
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('tour_arrangements', 'tour_arrangement_days', 'bullet_train_arrangements', 'arrangement_documents')
order by tablename, policyname;

-- ---- 本体(上記の確認結果を見た上で、コードデプロイ・動作確認後に実行すること) ----

grant select, insert, update, delete on public.tour_arrangements to service_role;
grant select, insert, update, delete on public.tour_arrangement_days to service_role;
grant select, insert, update, delete on public.bullet_train_arrangements to service_role;
grant select, insert, update, delete on public.arrangement_documents to service_role;

revoke insert, update, delete on public.tour_arrangements from anon, authenticated;
revoke insert, update, delete on public.tour_arrangement_days from anon, authenticated;
revoke insert, update, delete on public.bullet_train_arrangements from anon, authenticated;
revoke insert, update, delete on public.arrangement_documents from anon, authenticated;
-- selectは既存の一覧表示・PDF出力等の閲覧系機能を壊さないため、anon/authenticatedから剥奪しない

-- bullet_train_arrangementsに残存する「anon全権限」のRLSポリシー(roles={anon}, cmd=ALL,
-- qual=true。上記3)のpg_policies確認で実際に確認済み)をDROPする。
drop policy if exists "anon全権限" on public.bullet_train_arrangements;

-- 他3テーブル(tour_arrangements/tour_arrangement_days/arrangement_documents)について、
-- このリポジトリの作業セッションはSupabaseへの直接アクセス手段を持たないため、
-- 上記3)のpg_policies確認結果をこのセッションでは未確認・未反映(2026-08-25時点)。
-- 本体を実行する前に、必ず上記3)を実行して3テーブル分の結果を確認し、意味を失った・
-- 矛盾したポリシー(RLS無効なのに残っているもの、anon/authenticatedに書き込みを許可する
-- 内容のもの等)があれば、bullet_train_arrangementsと同じ形式で以下にDROP文を追記してから
-- 本体を実行すること。該当ポリシーが無ければ何も追記せず本体をそのまま実行してよい。
-- drop policy if exists "<<POLICY_NAME>>" on public.<<TABLE_NAME>>;

notify pgrst, 'reload schema';

-- ---- 実行後の確認(本体実行後、再度以下を流して意図通りになったか確認すること) ----

-- anonはselectのみ、authenticatedは何も無し、service_roleは全権限、が期待値
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('tour_arrangements', 'tour_arrangement_days', 'bullet_train_arrangements', 'arrangement_documents')
  and grantee in ('anon', 'authenticated', 'service_role')
order by table_name, grantee, privilege_type;

-- DROPしたポリシーが消えていることを確認
select schemaname, tablename, policyname, permissive, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('tour_arrangements', 'tour_arrangement_days', 'bullet_train_arrangements', 'arrangement_documents')
order by tablename, policyname;

-- ---- 切り戻し ----
-- 問題が起きた場合は、以下で元に戻せる(DROPしたポリシーの復元は別途CREATE POLICYが必要なため
-- ここには含まない。DROP前にポリシーの定義(qual/with_check)を必ず控えておくこと):
--   grant insert, update, delete on public.tour_arrangements to anon, authenticated;
--   grant insert, update, delete on public.tour_arrangement_days to anon, authenticated;
--   grant insert, update, delete on public.bullet_train_arrangements to anon, authenticated;
--   grant insert, update, delete on public.arrangement_documents to anon, authenticated;
--   notify pgrst, 'reload schema';
