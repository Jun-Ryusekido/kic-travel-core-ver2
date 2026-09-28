-- 施設ごとの「ガイドへの注意事項」と、手配行と取引先マスタの紐付け(2026-09-28 JUN決定)。
-- Supabase SQL Editor で、STEPごとに1回ずつ実行すること(1ブロック=1回の実行単位)。
--
-- 順番(重要):
--   STEP 0(確認・読み取り専用)→ STEP 1(テーブル作成・列追加)→ STEP 2(別名の初期登録)
--   → 重複登録の統合(scripts/merge_duplicate_peace_museum_partner.sql)
--   → コードのデプロイ(APP_VERSIONを上げた版)と全員の再読み込み
--   → STEP 3a(対象の確認・バックアップ)→ STEP 3b(紐付け・名前の統一)→ STEP 3c(確認)(業務時間外)→ 全員の再読み込み
-- 実行状況(2026-09-28 JUN): STEP 0・1・2 と重複登録の統合は実行済み。STEP 3 は未実行。
-- STEP 3 をコードのデプロイより前に実行しないこと: 今の画面は観光施設タブを保存するたびに
-- 全削除→再挿入するため、business_partner_id を知らない画面で保存すると紐付けが消える。

-- ===== STEP 0: 確認(読み取り専用) =====
-- 0-1. 取引先マスタの資料館の行。期待: 「広島平和記念資料館」が1行(is_deleted が true でない)。
select id, company_name, category, is_deleted
from public.business_partners
where company_name like '%資料館%' or company_name like '%平和%'
order by company_name;

-- 0-2. 追加する列・テーブルがまだ無いこと。期待: 0行。
select table_name, column_name from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'booking_facilities' and column_name = 'business_partner_id')
       or table_name in ('business_partner_guide_notices', 'business_partner_aliases'));

-- ===== STEP 1: テーブル作成・列追加 =====
-- 別名・注意事項の照合に使う正規化(NFKC・小文字・空白と「、,・」の除去)。
-- 画面側(index.html)も同じ規則で正規化する。
create table if not exists public.business_partner_guide_notices (
  id uuid primary key default gen_random_uuid(),
  business_partner_id uuid not null references public.business_partners(id) on delete cascade,
  notice_type text not null check (notice_type in ('payment', 'document', 'other')),
  content text not null check (char_length(btrim(content)) > 0),
  required_doc text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists business_partner_guide_notices_partner_idx
  on public.business_partner_guide_notices(business_partner_id);
grant select, insert, update, delete on public.business_partner_guide_notices to service_role;
alter table public.business_partner_guide_notices enable row level security;

create table if not exists public.business_partner_aliases (
  id uuid primary key default gen_random_uuid(),
  business_partner_id uuid not null references public.business_partners(id) on delete cascade,
  alias text not null check (char_length(btrim(alias)) > 0),
  alias_key text generated always as (
    regexp_replace(lower(normalize(alias, NFKC)), '[[:space:]、,・]', '', 'g')
  ) stored,
  match_type text not null default 'exact' check (match_type in ('exact', 'contains')),
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  -- 「含む」は短い語が他の施設を拾うため4文字以上(例: 「資料館」単独は登録できない)
  constraint business_partner_aliases_contains_min_len
    check (match_type <> 'contains' or char_length(alias_key) >= 4)
);
-- 同じ正規化キー・照合方法の別名は1つだけ(1つの表記が2つの取引先に結び付かないように)
create unique index if not exists business_partner_aliases_key_uniq
  on public.business_partner_aliases(match_type, alias_key);
create index if not exists business_partner_aliases_partner_idx
  on public.business_partner_aliases(business_partner_id);
grant select, insert, update, delete on public.business_partner_aliases to service_role;
alter table public.business_partner_aliases enable row level security;

alter table public.booking_facilities
  add column if not exists business_partner_id uuid references public.business_partners(id) on delete set null;
create index if not exists booking_facilities_business_partner_id_idx
  on public.booking_facilities(business_partner_id);

notify pgrst, 'reload schema';

-- 1-確認. 期待: 2テーブルとも rowsecurity=true、service_role に4権限、anon/authenticated は0行。
select tablename, rowsecurity from pg_tables
where schemaname = 'public' and tablename in ('business_partner_guide_notices', 'business_partner_aliases');
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('business_partner_guide_notices', 'business_partner_aliases')
  and grantee in ('anon', 'authenticated', 'service_role')
group by table_name, grantee order by table_name, grantee;

-- ===== STEP 2: 別名の初期登録(広島平和記念資料館) =====
-- 取引先マスタの「広島平和記念資料館」(削除されていないもの)がちょうど1行でなければ、何も登録せずエラーで止まる。
-- 「平和記念公園、資料館、貞子記念碑、原爆ﾄﾞｰﾑ」「平和記念会館・貞子記念碑・原爆ドーム」も含める(JUN確認、2026-09-28実行済み:
-- 完全一致5件・含む2件)。
do $$
declare
  v_partner uuid;
  v_n int;
begin
  select count(*) into v_n from public.business_partners
   where company_name = '広島平和記念資料館' and coalesce(is_deleted, false) = false;
  if v_n <> 1 then
    raise exception '取引先マスタの「広島平和記念資料館」が % 行です(1行であること)。登録を中止しました。', v_n;
  end if;
  select id into v_partner from public.business_partners
   where company_name = '広島平和記念資料館' and coalesce(is_deleted, false) = false;

  insert into public.business_partner_aliases (business_partner_id, alias, match_type, created_by, updated_by)
  select v_partner, a.alias, a.match_type, 'sql:initial', 'sql:initial'
  from (values
    ('平和記念資料館、原爆ﾄﾞｰﾑ､貞子碑', 'exact'),
    ('平和記念資料館', 'exact'),
    ('平和記念公園(平和資料館)', 'exact'),
    ('平和記念資料館・原爆ドーム・貞子碑', 'exact'),
    ('平和記念公園、資料館、貞子記念碑、原爆ﾄﾞｰﾑ', 'exact'),
    ('平和記念会館・貞子記念碑・原爆ドーム', 'exact'),
    ('平和記念資料館', 'contains'),
    ('平和資料館', 'contains')
  ) as a(alias, match_type)
  on conflict (match_type, alias_key) do nothing;
end $$;

-- 2-確認. 期待: 完全一致5件+含む2件。
-- 「平和記念資料館、原爆ﾄﾞｰﾑ､貞子碑」と「平和記念資料館・原爆ドーム・貞子碑」は正規化すると同じ
-- (平和記念資料館原爆ドーム貞子碑)になるため1件にまとまる(on conflict do nothing。どちらの表記も一致する)。
select a.alias, a.alias_key, a.match_type, p.company_name
from public.business_partner_aliases a join public.business_partners p on p.id = a.business_partner_id
order by a.match_type, a.alias;

-- ===== STEP 3: 既存の観光施設の行の紐付けと、施設名の統一(2026-09-28 JUN決定: 「広島平和記念資料館」に統一) =====
-- 実行するのは、コードのデプロイ(APP_VERSIONを上げた版)と全員の再読み込みの後。業務時間外に実行し、実行後にもう一度全員に
-- 再読み込みを依頼する(観光施設タブは保存のたびに全削除→再挿入するため、実行前から予約を開いたままの画面で保存されると、
-- その予約の行が元の名前・未紐付けに戻る。観光施設タブには保存時の食い違い検知が無い)。
-- 対象 = 正規化した施設名がマスタ名と一致、または別名(完全一致)と一致、または別名(含む)を含む行のうち、
--        まだ紐付いていない行、または既に資料館に紐付いている行。
--   紐付け : business_partner_id が空の行に資料館のidを入れる。
--   名前   : facility_name が「広島平和記念資料館」でない行を「広島平和記念資料館」に置き換える。
--   備考   : 置き換える行のうち、元の表記がマスタ名の一部ではない(= 原爆ドーム・貞子碑・平和記念公園など他の見学先を含む)行は、
--            備考(memo)の先頭に「元の表記: …」を付ける(既存の備考は「 / 」の後ろに残す)。
--            例: 「平和記念資料館」はマスタ名の一部なので備考に残さない。「平和記念公園(平和資料館)」は残す。
--   仕入明細: 「仕入明細へ追加」で作られた仕入明細(booking_costs)は、追加元の名前(source_snapshot.item_name)を持ち、名前が
--            変わると「追加元の仕入先名・日付が変更されています」の警告が出る。追加元の名前を置き換える行の分だけ、
--            source_snapshot.item_name を新しい名前に更新する(仕入明細の仕入先名 item_name・金額は変更しない)。

-- ===== STEP 3a: 対象の確認・バックアップ(読み取り専用) =====
-- 結果(JSON)を保存し、n_link / n_rename / n_memo / n_cost_snapshot を Claude に伝える。STEP 3b の件数ガードに使う。
-- 班の印(末尾の「(2班)」等)は照合から外し、置き換え後の名前にもそのまま残す(例: 「平和記念資料館(2班)」→「広島平和記念資料館(2班)」)。
with p as (
  select id, regexp_replace(lower(normalize(company_name, NFKC)), '[[:space:]、,・]', '', 'g') as name_key
  from public.business_partners
  where company_name = '広島平和記念資料館' and coalesce(is_deleted, false) = false
), f as (
  select bf.*,
         regexp_replace(lower(normalize(regexp_replace(coalesce(bf.facility_name, ''), '\(\d+班\)\s*$', ''), NFKC)), '[[:space:]、,・]', '', 'g') as fkey,
         '広島平和記念資料館' || coalesce(substring(bf.facility_name from '(\(\d+班\))\s*$'), '') as new_name
  from public.booking_facilities bf
  where bf.business_partner_id is null or bf.business_partner_id = (select id from p)
), t as (
  select f.*,
         f.business_partner_id is null as need_link,
         f.facility_name <> f.new_name as need_rename,
         f.facility_name <> f.new_name and strpos(p.name_key, f.fkey) = 0 as need_memo
  from f cross join p
  where f.fkey = p.name_key
     or exists (select 1 from public.business_partner_aliases a
                where a.business_partner_id = p.id and a.match_type = 'exact' and a.alias_key = f.fkey)
     or exists (select 1 from public.business_partner_aliases a
                where a.business_partner_id = p.id and a.match_type = 'contains' and strpos(f.fkey, a.alias_key) > 0)
), c as (
  select bc.* from public.booking_costs bc join t on bc.source_id::text = t.id::text
  where bc.source_table = 'booking_facilities' and t.need_rename
    and bc.source_snapshot->>'item_name' = t.facility_name
)
select
  (select count(*) from t) as n_target,
  (select count(*) from t where need_link) as n_link,
  (select count(*) from t where need_rename) as n_rename,
  (select count(*) from t where need_memo) as n_memo,
  (select count(*) from c) as n_cost_snapshot,
  (select json_agg(json_build_object('facility_name', facility_name, 'new_name', new_name, 'n', n, 'memo', m) order by n desc)
     from (select facility_name, new_name, count(*) as n, bool_or(need_memo) as m from t group by facility_name, new_name) s) as by_name,
  json_build_object(
    'booking_facilities', (select json_agg(x order by x.date, x.id) from (select id, booking_id, facility_name, date, memo, business_partner_id from t) x),
    'booking_costs', (select json_agg(c) from c)
  ) as backup;

-- ===== STEP 3b: 紐付け・名前の統一(件数ガード付き) =====
-- <n_link> <n_rename> <n_memo> <n_cost_snapshot> を STEP 3a の結果に置き換えてから実行する。
-- どれか1つでも件数が一致しなければ、何も変更せずエラーで止まる。
do $$
declare
  v_exp_link int := <n_link>;
  v_exp_rename int := <n_rename>;
  v_exp_memo int := <n_memo>;
  v_exp_cost int := <n_cost_snapshot>;
  v_partner uuid;
  v_key text;
  v_n int;
begin
  select id, regexp_replace(lower(normalize(company_name, NFKC)), '[[:space:]、,・]', '', 'g')
    into strict v_partner, v_key
    from public.business_partners
   where company_name = '広島平和記念資料館' and coalesce(is_deleted, false) = false;

  create temp table _peace_targets on commit drop as
  select f.id, f.facility_name as old_name, f.new_name,
         f.business_partner_id is null as need_link,
         f.facility_name <> f.new_name as need_rename,
         f.facility_name <> f.new_name and strpos(v_key, f.fkey) = 0 as need_memo
  from (
    select bf.id, bf.facility_name, bf.business_partner_id,
           regexp_replace(lower(normalize(regexp_replace(coalesce(bf.facility_name, ''), '\(\d+班\)\s*$', ''), NFKC)), '[[:space:]、,・]', '', 'g') as fkey,
           '広島平和記念資料館' || coalesce(substring(bf.facility_name from '(\(\d+班\))\s*$'), '') as new_name
    from public.booking_facilities bf
    where bf.business_partner_id is null or bf.business_partner_id = v_partner
  ) f
  where f.fkey = v_key
     or exists (select 1 from public.business_partner_aliases a
                where a.business_partner_id = v_partner and a.match_type = 'exact' and a.alias_key = f.fkey)
     or exists (select 1 from public.business_partner_aliases a
                where a.business_partner_id = v_partner and a.match_type = 'contains' and strpos(f.fkey, a.alias_key) > 0);

  -- 仕入明細の追加元の名前(名前を置き換える前に、元の名前で照合する)
  update public.booking_costs bc
     set source_snapshot = jsonb_set(bc.source_snapshot::jsonb, '{item_name}', to_jsonb(t.new_name))
    from _peace_targets t
   where bc.source_table = 'booking_facilities' and bc.source_id::text = t.id::text and t.need_rename
     and bc.source_snapshot->>'item_name' = t.old_name;
  get diagnostics v_n = row_count;
  if v_n <> v_exp_cost then
    raise exception '仕入明細の追加元の名前の更新 % 件が STEP 3a の % 件と一致しません。取り消しました。', v_n, v_exp_cost;
  end if;

  update public.booking_facilities bf set business_partner_id = v_partner
    from _peace_targets t where bf.id = t.id and t.need_link;
  get diagnostics v_n = row_count;
  if v_n <> v_exp_link then
    raise exception '紐付け % 件が STEP 3a の % 件と一致しません。取り消しました。', v_n, v_exp_link;
  end if;

  update public.booking_facilities bf
     set memo = '元の表記: ' || t.old_name || case when coalesce(btrim(bf.memo), '') <> '' then ' / ' || bf.memo else '' end
    from _peace_targets t where bf.id = t.id and t.need_memo;
  get diagnostics v_n = row_count;
  if v_n <> v_exp_memo then
    raise exception '備考への記録 % 件が STEP 3a の % 件と一致しません。取り消しました。', v_n, v_exp_memo;
  end if;

  update public.booking_facilities bf set facility_name = t.new_name
    from _peace_targets t where bf.id = t.id and t.need_rename;
  get diagnostics v_n = row_count;
  if v_n <> v_exp_rename then
    raise exception '名前の置き換え % 件が STEP 3a の % 件と一致しません。取り消しました。', v_n, v_exp_rename;
  end if;

  raise notice '完了: 紐付け % 件、名前の置き換え % 件(うち備考に元の表記 % 件)、仕入明細の追加元の名前 % 件。',
    v_exp_link, v_exp_rename, v_exp_memo, v_exp_cost;
end $$;

-- ===== STEP 3c: 確認(読み取り専用) =====
-- 期待: 資料館に紐付いた行はすべて「広島平和記念資料館」(班の印付きを含む)、件数は STEP 3a の n_target。
select bf.facility_name, count(*) as n, count(*) filter (where bf.memo like '元の表記: %') as n_memo
from public.booking_facilities bf
join public.business_partners p on p.id = bf.business_partner_id
where p.company_name = '広島平和記念資料館' and coalesce(p.is_deleted, false) = false
group by bf.facility_name order by n desc;

-- 備考に元の表記を残した行(期待: STEP 3a の n_memo 件。既存の備考は「 / 」の後ろに残っている)。
select bf.id, bf.date, bf.facility_name, bf.memo
from public.booking_facilities bf
where bf.memo like '元の表記: %' order by bf.date;

-- 資料館らしいのに紐付いていない行(期待: 資料館以外の施設だけ。別名に入れなかった資料館の表記があればここに出る)。
select facility_name, count(*) as n
from public.booking_facilities
where business_partner_id is null
  and (facility_name like '%資料館%' or facility_name like '%平和%')
group by facility_name order by n desc;

-- 仕入明細の追加元の名前が古いまま残っていないこと(期待: 0行)。
select bc.id, bc.item_name, bc.source_snapshot->>'item_name' as snapshot_name, bf.facility_name
from public.booking_costs bc
join public.booking_facilities bf on bc.source_id::text = bf.id::text
where bc.source_table = 'booking_facilities' and bf.business_partner_id is not null
  and bc.source_snapshot->>'item_name' <> bf.facility_name;
