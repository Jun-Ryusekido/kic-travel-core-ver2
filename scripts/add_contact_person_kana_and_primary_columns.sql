-- 取引先マスタ担当者(business_partner_contacts)に読み仮名・代表担当者フラグを追加。
--
-- 背景:
-- - contact_person(担当者名)は漢字表記のみのため、読み方が分からないケースがある
--   (例:「劉 芷瑀」)。読み仮名(カタカナ)を別途保持できるようにする。
-- - 1社に複数の担当者がいる場合、「代表担当者」を明示的に指定できるようにする
--   (取引先一覧・取引先詳細モーダルで、代表が未設定の会社は従来通り登録順
--   1人目を表示するフォールバックのまま)。
--
-- 既存データへの影響: 新規列はどちらもNULL許容(is_primaryはdefault falseだが
-- 既存行はNOT NULL制約を付けていないため、追加時に既存行全件がfalseになるだけで
-- エラーにはならない)。business_partners自体・そのRLS/GRANTは一切変更しない。

alter table public.business_partner_contacts
  add column if not exists contact_person_kana text,
  add column if not exists is_primary boolean not null default false;

-- 1社につき代表担当者は常に1人まで、という制約はアプリ側(setPrimaryContact、
-- index.html)で担保する(対象をtrueにする際、同じbusiness_partner_idの他行を
-- 都度falseに更新する)。DB側でのunique partial index等による強制は今回のスコープ外。

notify pgrst, 'reload schema';
