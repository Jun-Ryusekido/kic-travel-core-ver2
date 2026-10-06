-- ============================================================
-- email_import_queue 停止中ロックのロールバック【設計のみ・未実行(2026-10-06)】
--
-- ロック前に保存した precheck の2(権限マトリクス)・3(付与の実体)・4(ポリシー)の結果に合わせて復元する。
-- 下記のうち、ロック前の状態に無かったものは実行しない。
-- ・リポジトリ上で確認できるロック前の状態(scripts/lock_down_email_import_queue_writes.sql):
--   anon/authenticatedにSELECTのみ。INSERT/UPDATE/DELETEは剥奪済み。
-- ・ただし運用中のDBでは「anonのINSERT・SELECTが通る」との報告があり、リポジトリの記録と
--   食い違っている可能性がある。必ずロック前のprecheck結果を正とすること。
-- ポリシーの再作成(c)は、コメントを外して <<...>> の部分をprecheck 4の結果で埋めてから実行する
-- (埋めないままコメントを外すと構文エラーで止まる)。
-- ============================================================
begin;

-- (a) SELECT権限の復元(リポジトリ記録上のロック前の状態)
grant select on public.email_import_queue to anon, authenticated;

-- (b) precheck 2/3でanon/authenticatedにINSERT/UPDATE/DELETEが付いていた場合のみ、付いていたものだけ復元
-- grant insert on public.email_import_queue to anon;
-- grant update on public.email_import_queue to anon;
-- grant delete on public.email_import_queue to anon;

-- (c) anon向けポリシーの再作成(precheck 4の policyname / cmd / qual / with_check をそのまま使う)
-- create policy "<<precheck 4のpolicyname(INSERT)>>" on public.email_import_queue
--   as permissive for insert to anon with check (<<with_check>>);
-- create policy "<<precheck 4のpolicyname(SELECT)>>" on public.email_import_queue
--   as permissive for select to anon using (<<qual>>);
-- create policy "<<precheck 4のpolicyname(UPDATE)>>" on public.email_import_queue
--   as permissive for update to anon using (<<qual>>) with check (<<with_check>>);

-- (d) email_import_queue_archive は作成時(scripts/archive_email_import_queue.sql)から
--     anon/authenticatedの権限なし・service_role専用のため、復元不要(RLSを有効化した場合も
--     service_roleはRLSをバイパスするため影響なし)。

-- 参考: service_roleの権限はロックしても変えていない(戻す必要なし)。

notify pgrst, 'reload schema';

commit;
