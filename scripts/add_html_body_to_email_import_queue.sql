-- email_import_queue に、Outlookメール本文のHTML版(html_body)列を追加する。
--
-- 背景: 従来はOutlookマクロ(email-automation/ThisOutlookSession.vba)が.Body(プレーン
-- テキスト)のみを取得・送信しており、色(赤字)等の書式情報を一切保持していなかった。
-- はやぶさ国際観光バスからの「手配不可の日を赤字で表示します」という注記付きメールで、
-- どの回が手配不可だったか一切判別できなかった問題への対応。VBA側は既に.HTMLBodyも
-- 送信JSONのhtml_bodyフィールドとして送るよう更新されており(埋め込み画像のdata:base64
-- は事前に除去、50000文字で切り詰め済み)、この列を受け皿として用意する。
--
-- 過去データへの遡及取得・バックフィルは不要(今後受信する分のみ対象)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。
--
-- 【GRANTについて】
-- email_import_queue は lock_down_email_import_queue_writes.sql により、anon/authenticated
-- は SELECT のみ・service_role は全権限、という形で既にロックダウン済み。PostgreSQLの
-- GRANTはテーブル単位であり新規列にも自動的に及ぶため、列追加のみのこの変更で改めて
-- GRANTを実行する必要はない(誤って anon/authenticated に insert/update/delete を
-- 再付与してロックダウンを崩さないよう、意図的にGRANT文は含めていない)。

alter table public.email_import_queue
  add column if not exists html_body text;

notify pgrst, 'reload schema';
