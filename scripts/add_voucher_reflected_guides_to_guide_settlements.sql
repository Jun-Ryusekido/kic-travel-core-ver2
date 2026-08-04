-- ガイド精算(guide_settlements)の「📋 伝票内容を仕入明細に反映」ボタン
-- (reflectVoucherToCost)に重複防止フラグを持たせるための列追加。
--
-- 背景: このボタンには重複防止の仕組みが一切無く、多人数ガイド設定の描画コードに
-- 同じボタンが3重に出力されるテンプレート不具合(index.html renderGuideSettlements)も
-- 重なり、本番のbooking_costsに実際に重複行が挿入される実害が発生していた
-- (2予約・差額計¥81,515相当。詳細は別途調査済み)。
--
-- 1件の精算(guide_settlements)は複数ガイド(guide_names jsonb配列)を含み得るため、
-- どのガイド(配列インデックス)まで反映済みかをjsonb配列で保持する
-- (例: [0] = インデックス0のガイド分は反映済み、[0,1] = 0・1とも反映済み)。
-- 単一ガイドの旧形式(guide_names列が無く、legacyの単一フィールドを使う設定)でも
-- 常にguideIndex=0として扱われるため、この配列だけで両方のケースをカバーできる。
alter table public.guide_settlements
  add column if not exists voucher_reflected_guides jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';
