-- 取引先マスタ(business_partners)一覧のサーバー側検索・絞り込み方式への切り替え。
--
-- 背景: 現在772件で、.range()すら無い無制限の全件取得+クライアント側フィルタ
-- だった。1000件到達が近く、Access移行での100万件規模も見込み、検索語・
-- カテゴリ絞り込みをSupabase側のRPC関数で行う方式に変更する。
--
-- ORDER BYには一意なid列をタイブレーカーとして含める(company_nameの同値が
-- 多数あると、.range()によるページング境界で行の重複・欠落が起きるため。
-- 入出金管理RPCで実際に発生した問題と同じ)。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

create or replace function search_business_partners(p_search text default null, p_category text default null)
returns setof business_partners
language sql stable
as $$
  select *
  from business_partners
  where (is_deleted is null or is_deleted = false)
    and (p_category is null or p_category = '' or category = p_category)
    and (
      p_search is null or p_search = '' or
      concat_ws(' ', company_name, company_name_en, branch_name, branch_name_en,
        contact_person, contact_person_en, phone, company_phone, fax, email, address, notes)
      ilike '%'||p_search||'%'
    )
  order by company_name, id;
$$;

grant execute on function search_business_partners(text, text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
