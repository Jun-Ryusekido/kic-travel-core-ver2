-- 合算Invoice(invoices.is_consolidated = true)のagent_idを、予約(bookings)のagent_idで埋める
-- (2026-09 JUN決定(b)、RLS対応フェーズ2 バッチ1)。
-- 背景: upsertConsolidatedInvoice(index.html)は合算Invoiceをagent_id = null固定で作成していたため、
-- ダッシュボードの「Agentマスタ未紐付け」バナー(refreshAgentUnlinkedBanner)に請求書として数えられていた。
-- バッチ1のコード修正で今後の作成・更新時は予約のagent_idを入れるようにしたため、既存分をこのSQLで埋める。
-- 予約のagent_idがnullの合算は対象外(nullのまま。バナーに出るのが正しい)。
-- 対象はid固定ではなく条件で絞る(PR #209以降、個別Invoiceの発行のたびに合算が自動作成されるため、
-- JUN確認時点の2件から増えている可能性がある)。
--
-- Supabaseダッシュボードの SQL Editor で、上から順に実行すること。
-- CLAUDE.mdの「削除・一括更新を伴う操作」の4ステップに従う:
--   (1) STEP1の結果(JSON)をバックアップとして保存
--   (2) STEP2の件数・内容をJUNが確認
--   (3) STEP3(UPDATE)の v_expected にSTEP2の件数を入れて実行。件数が一致しなければ自動で取り消される
--   (4) STEP4で対象が0件になったことを確認
-- 注意: SQLでの直接更新はaudit_logsに記録されない(記録はapi/table-crud.js経由の操作のみ)。
-- 実行後は画面をハードリロードして確認すること(5分TTLキャッシュのため)。

-- 共通の対象条件(STEP1〜4で同一):
--   invoices.is_consolidated = true かつ invoices.agent_id is null
--   かつ 紐付く予約(bookings.id = invoices.booking_id)の agent_id is not null

-- ============================================================
-- STEP1: バックアップ(対象の合算Invoiceの更新前の内容をJSONで取得。結果を保存しておく)
-- ============================================================
select json_agg(json_build_object(
  'id', i.id, 'invoice_no', i.invoice_no, 'booking_id', i.booking_id, 'currency', i.currency,
  'agent_name', i.agent_name, 'agent_id', i.agent_id, 'status', i.status, 'amount', i.amount,
  'booking_ref_no', b.ref_no, 'booking_agent_id', b.agent_id
) order by i.created_at) as backup_json
from public.invoices i
join public.bookings b on b.id = i.booking_id
where i.is_consolidated = true
  and i.agent_id is null
  and b.agent_id is not null;

-- ============================================================
-- STEP2: 対象一覧(目視確認用)と件数
-- ============================================================
select i.id, i.invoice_no, b.ref_no, i.currency, i.agent_name as invoice_agent_name,
       b.agent_name as booking_agent_name, b.agent_id as booking_agent_id, i.status, i.created_at
from public.invoices i
join public.bookings b on b.id = i.booking_id
where i.is_consolidated = true
  and i.agent_id is null
  and b.agent_id is not null
order by i.created_at;

-- 件数(target_rows = STEP3で v_expected に入れる値)。参考: 予約のagent_idがnullのため対象外の合算の件数
select
  (select count(*) from public.invoices i join public.bookings b on b.id = i.booking_id
    where i.is_consolidated = true and i.agent_id is null and b.agent_id is not null) as target_rows,
  (select count(*) from public.invoices i join public.bookings b on b.id = i.booking_id
    where i.is_consolidated = true and i.agent_id is null and b.agent_id is null) as skipped_booking_agent_null,
  (select count(*) from public.invoices where is_consolidated = true) as consolidated_total;

-- ============================================================
-- STEP3: 更新(1トランザクション)。v_expected にSTEP2の target_rows の値を入れてから実行する。
--   v_expected が null のままだと実行せずに中止する。
--   STEP1/2と同じ条件で対象を確定 → 件数がv_expectedと一致しなければ例外で全体を取り消す。
-- ============================================================
begin;

do $$
declare
  v_expected int := null;   -- ← STEP2の target_rows の値に書き換えてから実行する
  v_target int;
  v_updated int;
begin
  if v_expected is null then
    raise exception 'v_expected が未設定です。STEP2の target_rows の値を入れてから実行してください';
  end if;

  create temp table _fix_consolidated_agent_targets on commit drop as
  select i.id, b.agent_id as new_agent_id
  from public.invoices i
  join public.bookings b on b.id = i.booking_id
  where i.is_consolidated = true
    and i.agent_id is null
    and b.agent_id is not null;

  select count(*) into v_target from _fix_consolidated_agent_targets;
  if v_target <> v_expected then
    raise exception '対象件数が想定と異なります(対象=%件, 想定=%件)。何も変更せず中止します', v_target, v_expected;
  end if;

  update public.invoices i
     set agent_id = t.new_agent_id
    from _fix_consolidated_agent_targets t
   where i.id = t.id
     and i.is_consolidated = true
     and i.agent_id is null;
  get diagnostics v_updated = row_count;

  if v_updated <> v_expected then
    raise exception '更新件数が想定と異なります(更新=%件, 想定=%件)。全体を取り消します', v_updated, v_expected;
  end if;
  raise notice '更新件数: %件(想定どおり)', v_updated;
end $$;

commit;

-- ============================================================
-- STEP4: 確認
--   (a) 対象条件に当てはまる行が0件になったこと(期待: remaining = 0)
--   (b) 全合算Invoiceのagent_idが予約のagent_idと一致していること(期待: mismatch = 0。
--       予約のagent_idがnullの合算はnullのまま = 一致扱い)
-- ============================================================
select
  (select count(*) from public.invoices i join public.bookings b on b.id = i.booking_id
    where i.is_consolidated = true and i.agent_id is null and b.agent_id is not null) as remaining,
  (select count(*) from public.invoices i join public.bookings b on b.id = i.booking_id
    where i.is_consolidated = true and i.agent_id is distinct from b.agent_id) as mismatch;

select i.id, i.invoice_no, b.ref_no, i.currency, i.agent_id, b.agent_id as booking_agent_id, i.status
from public.invoices i
join public.bookings b on b.id = i.booking_id
where i.is_consolidated = true
order by i.created_at;
