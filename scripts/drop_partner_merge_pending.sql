-- ============================================================
-- partner_merge_pending: コードから一切参照されていない孤児テーブルの削除(2026-09-08)。
--
-- 背景: 名刺スキャン自動マージ機能の「保留」選択肢(3択: マージ/新規登録/保留)は
-- コミット9b918b9(PR #121、2026-08-29マージ)でユーザー確認の上、完全に削除された
-- (2択のマージ/新規登録に統一)。削除時、本テーブルへの参照コード
-- (postponePartnerMergeCandidate/openPartnerMergePendingModal等)は全て除去済みだが、
-- テーブル自体は本番にDROPせず残置していた。以後コードからの参照は復活しておらず、
-- agent_info/payments/suppliers(PR時点でコード参照0件・TABLE_CONFIG未登録と判明し
-- DROP済み、scripts/backup_supabase.ps1のコメント参照)と同じ状況のため、同じ手順で削除する。
--
-- 実行前に必ず本ファイルの1.を実行し、target_countが0件であることを確認すること。
-- 万一0件でなかった場合は、2.のJSON出力をバックアップとして保存してから3.へ進むこと。
-- ============================================================

-- 1. 削除前の件数確認(0件のはず)
select count(*) as target_count
from public.partner_merge_pending;

-- 2. 万一データが残っていた場合のJSONバックアップ(0件ならNULLが返るだけで無害)
--    出力されたJSONをそのままファイルに保存してからDROPへ進むこと。
select json_agg(t) as backup_json
from public.partner_merge_pending t;

-- 3. テーブルの削除
drop table if exists public.partner_merge_pending;

-- 4. 削除確認(0件、またはエラーなく空になっていることを確認)
select count(*) as remaining_count
from information_schema.tables
where table_schema = 'public'
  and table_name = 'partner_merge_pending';
