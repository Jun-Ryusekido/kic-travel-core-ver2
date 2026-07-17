-- arrangement_documents系テーブルがPostgRESTのスキーマに一切表示されない(PGRST205)問題への対処。
-- create_arrangement_documents_tables.sqlではRLSを無効化しただけで、anon/authenticatedロールへの
-- 明示的なGRANTを行っていなかったため、権限が無いテーブルとしてPostgRESTから完全に見えなくなっていた
-- (エラーではなく非表示になるのが、権限不足特有の症状)。
-- Supabaseダッシュボードの SQL Editor で実行すること。

grant select, insert, update, delete on public.arrangement_documents to anon, authenticated, service_role;
grant select, insert, update, delete on public.arrangement_document_days to anon, authenticated, service_role;
grant select, insert, update, delete on public.arrangement_document_notes to anon, authenticated, service_role;

-- id列がuuidでdefault gen_random_uuid()のため配列(sequence)権限は不要。

notify pgrst, 'reload schema';
