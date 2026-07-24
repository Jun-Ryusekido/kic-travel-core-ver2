-- セキュリティ移行フェーズ1: parking_reservations(駐車場 今すぐ予約)への
-- anon/authenticatedからの直接アクセスを遮断する。
--
-- 背景: parking_reservationsは支払方法・車両ナンバー・運転手氏名・連絡先電話番号等を
-- 含むが、他の運用テーブルと同様anonキーからselect/insert/update/deleteが可能な状態
-- だった。ブラウザの開発者ツール等からSupabase URLとanonキーを使えば、誰でもこれらの
-- 情報を直接閲覧・改ざんできてしまうリスクがあった。
--
-- 対応: 一覧取得(action:list)・新規作成/更新(action:save)・削除(action:delete)を、
-- すべてservice_role keyを使うサーバーレス関数(/api/parking-reservations、
-- actionパラメータで分岐)経由に変更したため、anon/authenticatedロールからの
-- parking_reservations直接アクセスを完全に遮断する(app_usersのlock_down_app_users.sqlと
-- 同じパターン)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

revoke all on public.parking_reservations from anon, authenticated;

-- service_roleは新設のAPI(service_role key使用)が必要とするため、明示的に権限を残す。
grant select, insert, update, delete on public.parking_reservations to service_role;

notify pgrst, 'reload schema';
