-- セキュリティ中長期対応 フェーズ2(続き): agents(取引先マスタ・Agent)への
-- 書き込みをservice_role経由に限定する。
--
-- 背景: business_partners(scripts/lock_down_business_partners_writes.sql参照)と
-- 同様、agentsもこれまでanonキーからinsert/update/deleteが直接可能な状態だった。
--
-- 対応: 取引先(Agent)マスタ画面の新規登録・編集(saveAgent)、論理削除・復元
-- (deleteAgent/restoreAgent)、完全削除(permanentlyDeleteAgent)を全て
-- service_role key経由の/api/table-crudに変更したため、anon/authenticatedロールからの
-- 直接書き込みを禁止する。
--
-- 読み取り(select)は今回変更しない。取引先(Agent)マスタ一覧等、既存の閲覧系機能は
-- 従来通りanonキー+RLSのまま動作する。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

revoke insert, update, delete on public.agents from anon, authenticated;

-- service_roleは/api/table-crud(service_role key使用)が必要とするため、
-- 明示的に権限を残す(select含め、読み取り確認等でも使えるようにフルアクセスにしておく)。
grant select, insert, update, delete on public.agents to service_role;

notify pgrst, 'reload schema';
