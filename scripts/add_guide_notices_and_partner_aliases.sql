-- 施設ごとの「ガイドへの注意事項」と、手配行と取引先マスタの紐付け(2026-09-28 JUN決定)。
-- Supabase SQL Editor で、STEPごとに1回ずつ実行すること(1ブロック=1回の実行単位)。
--
-- 順番(重要):
--   STEP 0(確認・読み取り専用)→ STEP 1(テーブル作成・列追加)→ STEP 2(別名の初期登録)
--   → コードのデプロイ(APP_VERSIONを上げた版)と全員の再読み込み
--   → STEP 3a(紐付け対象の確認・バックアップ)→ STEP 3b(紐付け)→ STEP 3c(確認)
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
-- 「平和記念公園、資料館、貞子記念碑、原爆ﾄﾞｰﾑ」「平和記念会館・貞子記念碑・原爆ドーム」はJUN確認中のため
-- コメントにしてある(含める場合は行頭の -- を外す)。
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
    -- ('平和記念公園、資料館、貞子記念碑、原爆ﾄﾞｰﾑ', 'exact'),
    -- ('平和記念会館・貞子記念碑・原爆ドーム', 'exact'),
    ('平和記念資料館', 'contains'),
    ('平和資料館', 'contains')
  ) as a(alias, match_type)
  on conflict (match_type, alias_key) do nothing;
end $$;

-- 2-確認. 期待: 完全一致3件+含む2件(確認中の2件を含めた場合は完全一致5件)。
-- 「平和記念資料館、原爆ﾄﾞｰﾑ､貞子碑」と「平和記念資料館・原爆ドーム・貞子碑」は正規化すると同じ
-- (平和記念資料館原爆ドーム貞子碑)になるため1件にまとまる(on conflict do nothing。どちらの表記も一致する)。
select a.alias, a.alias_key, a.match_type, p.company_name
from public.business_partner_aliases a join public.business_partners p on p.id = a.business_partner_id
order by a.match_type, a.alias;

-- ===== STEP 3a: 紐付け対象の確認・バックアップ(読み取り専用。コードのデプロイ後に実行) =====
-- 資料館に紐付く行 = 正規化した施設名がマスタ名と一致、または別名(完全一致)と一致、または別名(含む)を含む。
-- 結果(JSON)を保存し、件数(n)をClaudeに伝える。STEP 3b の件数ガードに使う。
with p as (
  select id, regexp_replace(lower(normalize(company_name, NFKC)), '[[:space:]、,・]', '', 'g') as name_key
  from public.business_partners
  where company_name = '広島平和記念資料館' and coalesce(is_deleted, false) = false
), f as (
  select bf.*, regexp_replace(lower(normalize(coalesce(bf.facility_name, ''), NFKC)), '[[:space:]、,・]', '', 'g') as fkey
  from public.booking_facilities bf
  where bf.business_partner_id is null
), targets as (
  select f.id, f.booking_id, f.facility_name, f.date, f.status, f.payment_method
  from f cross join p
  where f.fkey = p.name_key
     or exists (select 1 from public.business_partner_aliases a
                where a.business_partner_id = p.id and a.match_type = 'exact' and a.alias_key = f.fkey)
     or exists (select 1 from public.business_partner_aliases a
                where a.business_partner_id = p.id and a.match_type = 'contains' and strpos(f.fkey, a.alias_key) > 0)
)
select count(*) as n, json_agg(targets order by date, id) as backup from targets;

-- ===== STEP 3b: 紐付け(件数ガード付き) =====
-- <STEP3aの件数> を STEP 3a の n に置き換えてから実行する。件数が一致しなければ何も更新せずエラーで止まる。
do $$
declare
  v_expected int := <STEP3aの件数>;
  v_partner uuid;
  v_n int;
begin
  select id into strict v_partner from public.business_partners
   where company_name = '広島平和記念資料館' and coalesce(is_deleted, false) = false;

  with f as (
    select bf.id, regexp_replace(lower(normalize(coalesce(bf.facility_name, ''), NFKC)), '[[:space:]、,・]', '', 'g') as fkey
    from public.booking_facilities bf
    where bf.business_partner_id is null
  ), targets as (
    select f.id from f
    where f.fkey = (select regexp_replace(lower(normalize(company_name, NFKC)), '[[:space:]、,・]', '', 'g')
                    from public.business_partners where id = v_partner)
       or exists (select 1 from public.business_partner_aliases a
                  where a.business_partner_id = v_partner and a.match_type = 'exact' and a.alias_key = f.fkey)
       or exists (select 1 from public.business_partner_aliases a
                  where a.business_partner_id = v_partner and a.match_type = 'contains' and strpos(f.fkey, a.alias_key) > 0)
  )
  update public.booking_facilities bf set business_partner_id = v_partner
  from targets t where bf.id = t.id;
  get diagnostics v_n = row_count;

  if v_n <> v_expected then
    raise exception '更新件数 % が STEP 3a の件数 % と一致しません。取り消しました。', v_n, v_expected;
  end if;
  raise notice '% 件を紐付けました。', v_n;
end $$;

-- ===== STEP 3c: 確認(読み取り専用) =====
-- 期待: 資料館に紐付いた行が STEP 3a と同じ件数・同じ表記。「未紐付けの資料館らしい行」は確認中の2表記だけ(含めなかった場合)。
select bf.facility_name, count(*) as n
from public.booking_facilities bf
join public.business_partners p on p.id = bf.business_partner_id
where p.company_name = '広島平和記念資料館'
group by bf.facility_name order by n desc;

select facility_name, count(*) as n
from public.booking_facilities
where business_partner_id is null
  and (facility_name like '%資料館%' or facility_name like '%平和%')
group by facility_name order by n desc;
