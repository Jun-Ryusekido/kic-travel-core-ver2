-- 仮払い一覧表(local_expenses)の数量(qty)を「未確定」= NULL で保存できるようにする(2026-09-27)。
-- 画面は「よく使う項目」で数量を決められなかった行を qty=NULL・amount=0 で保存する(以前は qty=1・amount=0 という
-- 食い違った行を保存していた)。qty に NOT NULL 制約があると、その行を含む仮払い一覧表の保存が失敗するため、
-- コードのデプロイ(マージ)より前に STEP 1 で確認し、NOT NULL なら STEP 2 を実行する。
-- 1ブロック=1回の実行単位。JUNがSupabase SQL Editorで実行する。

-- ===== STEP 1(読み取り専用): qty 列の型・NULL可否・既定値 =====
-- 期待: is_nullable = 'YES' なら STEP 2 は不要。'NO' なら STEP 2 を実行する。
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'local_expenses' and column_name in ('qty', 'unit_price', 'amount')
order by column_name;

-- ===== STEP 2(STEP 1 で qty の is_nullable が 'NO' の場合のみ): NOT NULL 制約を外す =====
-- 既定値(column_default)は変更しない。既存データは変わらない。
alter table public.local_expenses alter column qty drop not null;
notify pgrst, 'reload schema';

-- ===== STEP 3(読み取り専用): 確認 =====
-- 期待: qty の is_nullable = 'YES'。
select column_name, is_nullable from information_schema.columns
where table_schema = 'public' and table_name = 'local_expenses' and column_name = 'qty';

-- 参考(読み取り専用): 以前の不具合で「数量1・金額0」になっている「よく使う項目」の行の件数(修正は別途判断)。
select content, count(*) as rows
from public.local_expenses
where content in ('お茶代','朝食代(乗務員)','昼食代(乗務員)','夕食代(乗務員)','予備費','通信費')
  and coalesce(qty, 1) = 1 and coalesce(amount, 0) = 0 and coalesce(unit_price, 0) > 0
group by content order by content;
