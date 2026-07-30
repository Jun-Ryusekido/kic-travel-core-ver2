-- ガイド口座情報機能: guide_bank_accounts子テーブルの新設。
--
-- 背景: guidesテーブルには既にbank_info(単一のフリーテキスト列)があるが、
-- 1ガイドが複数口座を持つケース・口座名義が本人以外(会社・家族等)のケースを
-- 構造化して保持できないため、新たに子テーブルとして新設する。
-- 既存のbank_info列はそのまま残し、非破壊とする(将来的な移行要否は別途判断)。
--
-- このテーブルは新設のため、最初からservice_role経由の書き込みのみとし、
-- anonロールへの書き込みGRANTは一切行わない(batch Aのような後追いのREVOKEは不要)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

create table if not exists public.guide_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  guide_id uuid references public.guides(id) on delete cascade,
  bank_name text,
  branch_name text,
  account_type text,
  account_number text,
  account_holder_name text,
  -- 名義区分: 本人/会社/家族 等。自由入力(選択肢を固定しない)。
  holder_type text,
  -- Excelの「日本人（男性）」「女性」シート8列目(見出し無し)に入っていた
  -- 所属会社・提携エージェント名等。日付らしき値(例:「R8.2/26」)も
  -- 変換・解釈せずそのまま文字列として保持する。
  affiliation_memo text,
  -- 一般備考(将来の手入力用。Excel取り込み時は基本的に空)。
  memo text,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text
);

create index if not exists guide_bank_accounts_guide_id_idx on public.guide_bank_accounts(guide_id);

-- service_roleにのみ書き込み権限を付与する(anonには一切付与しない)。
grant select, insert, update, delete on public.guide_bank_accounts to service_role;

notify pgrst, 'reload schema';
