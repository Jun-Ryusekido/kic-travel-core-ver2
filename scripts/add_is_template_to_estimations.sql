-- 見積もり一覧の「テンプレート」機能のため、estimationsにis_templateフラグを追加する。
-- テンプレート指定した見積もりは通常の一覧から除外され、専用の折り畳みセクションに
-- 表示される(コード側の実装は別途)。
--
-- 既存のestimationsへの書き込みは全て直接anon key(sb.from('estimations'))経由のままの
-- テーブルのため(service_role API化は未実施)、今回のis_templateも同じ書き込み経路で
-- 統一する。既存のGRANTを変更する必要はないため、この列追加SQLも既存の権限構成に
-- 合わせてanon/authenticated/service_roleの3ロールにGRANTしておく。

alter table public.estimations
  add column if not exists is_template boolean not null default false;

grant select, insert, update, delete on public.estimations to anon, authenticated, service_role;

notify pgrst, 'reload schema';
