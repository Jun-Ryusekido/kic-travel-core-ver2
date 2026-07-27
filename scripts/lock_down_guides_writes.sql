-- セキュリティ中長期対応 フェーズ2(最終): guides(ガイドマスタ)への
-- 書き込みをservice_role経由に限定する。
--
-- 背景: business_partners/agents(scripts/lock_down_business_partners_writes.sql、
-- lock_down_agents_writes.sql参照)と同様、guidesもこれまでanonキーから
-- insert/update/deleteが直接可能な状態だった。
--
-- 対応: ガイド登録一覧画面の新規登録・編集(saveGuide)、削除(deleteGuide、
-- guidesにはis_deleted等の論理削除列が無いためハードデリート)、予約詳細の
-- ガイド検索から新規ガイドをその場登録する機能(submitNewGuide)を全て
-- service_role key経由の/api/table-crudに変更したため、anon/authenticatedロールからの
-- 直接書き込みを禁止する。
--
-- 読み取り(select)は今回変更しない。ガイド登録一覧・予約詳細のガイド検索候補等、
-- 既存の閲覧系機能は従来通りanonキー+RLSのまま動作する。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

revoke insert, update, delete on public.guides from anon, authenticated;

-- service_roleは/api/table-crud(service_role key使用)が必要とするため、
-- 明示的に権限を残す(select含め、読み取り確認等でも使えるようにフルアクセスにしておく)。
grant select, insert, update, delete on public.guides to service_role;

notify pgrst, 'reload schema';
