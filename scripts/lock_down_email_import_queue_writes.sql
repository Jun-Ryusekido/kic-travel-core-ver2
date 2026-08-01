-- email_import_queue(メール受信箱)へのanon直接書き込みを禁止する。
--
-- 【実行タイミング】
-- 必ず、コード側の切り替え(commit 6977bea: 9箇所すべてを/api/table-crud経由に変更)を
-- 本番デプロイし、実運用で「対象外にする/戻す/無視/一括無視/一括判定/取込済み/保留」の
-- 各操作が正常に動くことを確認してから実行すること。
-- 先にこのSQLを実行すると、古いJSを開いたままのタブからの操作が失敗する
-- (2026-07-27の本番インシデントと同じパターン)。
--
-- 【このSQLで変わること】
-- ・anon/authenticated からの INSERT/UPDATE/DELETE を剥奪する
-- ・SELECT は残す(受信箱の一覧表示・本文検索・広告判定が依存しているため)
-- ・service_role は全権限を維持(/api/table-crud はこのキーで書き込む)
--
-- 【切り戻し】
-- 問題が起きた場合は、以下で元に戻せる:
--   grant insert, update, delete on public.email_import_queue to anon, authenticated;
--   notify pgrst, 'reload schema';

revoke insert, update, delete on public.email_import_queue from anon;
revoke insert, update, delete on public.email_import_queue from authenticated;

grant select on public.email_import_queue to anon, authenticated;
grant select, insert, update, delete on public.email_import_queue to service_role;

notify pgrst, 'reload schema';
