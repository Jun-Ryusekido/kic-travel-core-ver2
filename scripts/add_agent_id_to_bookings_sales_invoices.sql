-- F13フェーズ2(agent_idバックフィル)の前提条件。
-- bookings/booking_sales/invoicesには現時点でagent_id列が存在しない(agent_nameの
-- 自由入力テキストのみ)。バックフィル本番実行(scripts/backfill_agent_id.js)の前に
-- このSQLをSupabase SQL Editorで実行しておくこと。
--
-- 方針: 既存のagent_name(text)列はそのまま残し、非破壊で追加する(F13事前調査の
-- 4フェーズ移行方針の通り。agent_nameからagent_idへの読み替えが安定するまでの間、
-- 両方を並行して持たせる)。
--
-- 実行順序:
--   1. このSQLでagent_id列を追加(NULL許容、FK制約付き)
--   2. scripts/backfill_agent_id_dryrun.jsで見込み件数を確認(このSQL実行前でも
--      実行可能。agent_id列を参照しないため)
--   3. scripts/backfill_agent_id.js --yes で実データを更新(バックアップ・
--      検証込み。まだ実行しない)
--   4. 以後の新規登録UI側でagent_idを併せて保存するようフロント側を改修(別タスク)

alter table public.bookings
  add column if not exists agent_id uuid references public.agents(id);

alter table public.booking_sales
  add column if not exists agent_id uuid references public.agents(id);

alter table public.invoices
  add column if not exists agent_id uuid references public.agents(id);

create index if not exists bookings_agent_id_idx on public.bookings(agent_id);
create index if not exists booking_sales_agent_id_idx on public.booking_sales(agent_id);
create index if not exists invoices_agent_id_idx on public.invoices(agent_id);

notify pgrst, 'reload schema';
