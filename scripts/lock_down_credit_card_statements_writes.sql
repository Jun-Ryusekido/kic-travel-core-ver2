-- 【2026-08-24 本番実行済み】
--
-- セキュリティ中長期対応: credit_card_statements(クレジットカード明細)への書き込みを
-- service_role経由に限定する。
--
-- 背景: credit_card_statementsの書き込み(OCR取込・マッチング確定・除外理由の記録等)は
-- 既にcreditCardStatementsApiCall()(index.html)→api/table-crud.js(service_role key使用、
-- insert/updateById/deleteById/deleteByIds、stampIdentity・auditLog有効)経由に移行済みだった。
-- ただしapi/table-crud.js側のコメントに明記されている通り、無停止移行のためこのREVOKEは
-- 「フェーズB相当」として意図的に先送りされていた(scripts/redesign_credit_card_statements.sql
-- 実行時点)。2026-08のシステム全体監査で、コード側に直接のsb.from('credit_card_statements')
-- によるinsert/update/delete/upsertが1件も残っていないこと(select読み取りのみ)を再確認した
-- ため、このREVOKEを実行した。
--
-- 読み取り(select)は今回変更しない。一覧表示・自動マッチング候補検索・クレカ明細⇔仕入明細の
-- 紐付け解除等、既存の閲覧系機能は従来通りanonキー+RLS無効のまま動作する。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

-- ---- 実行前の確認(このSQLの本体を実行する前に、まず単独で実行して現状を確認すること) ----
-- 1) RLSの有効/無効(rowsecurityがtrueなら有効。今回はfalseのまま維持する)
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'credit_card_statements';

-- 2) anon/authenticated/service_roleへのGRANT状況
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'credit_card_statements'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- ---- 本体(上記の確認結果を見た上で、コードデプロイ・動作確認後に実行すること) ----
revoke insert, update, delete on public.credit_card_statements from anon, authenticated;

-- service_roleは/api/table-crud(service_role key使用)が必要とするため、
-- 明示的に権限を残す(select含め、読み取り確認等でも使えるようにフルアクセスにしておく)。
grant select, insert, update, delete on public.credit_card_statements to service_role;

notify pgrst, 'reload schema';

-- ---- 実行後の確認(本体実行後、再度このクエリを流して意図通りになったか確認すること) ----
-- anonはselectのみ、authenticatedは何も無し、service_roleは全権限、が期待値
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'credit_card_statements'
  and grantee in ('anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

-- ---- 切り戻し ----
-- 問題が起きた場合は、以下で元に戻せる:
--   grant insert, update, delete on public.credit_card_statements to anon, authenticated;
--   notify pgrst, 'reload schema';
