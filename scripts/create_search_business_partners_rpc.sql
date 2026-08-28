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
-- 【2026-08 追記】取引先マスタの担当者情報一本化(business_partner_contacts)により、
-- branch_name/branch_name_en/contact_person/contact_person_en/phone等は
-- business_partners側の列を将来的に削除する予定のため、検索条件はこれらの列を
-- 直接参照せず、business_partner_contacts側の代表担当者(is_primary優先、
-- 無ければ登録順1人目)をLATERAL JOINして参照するよう変更した(getDisplayContactForPartner
-- と同じ解決ロジック)。返り値(setof business_partners)自体は変更していないため、
-- 呼び出し側(fetchAndRenderPartners)の扱いに変更は不要。
--
-- Supabaseダッシュボードの SQL Editor で実行すること。

create or replace function search_business_partners(p_search text default null, p_category text default null)
returns setof business_partners
language sql stable
as $$
  select bp.*
  from business_partners bp
  left join lateral (
    select bc.branch_name, bc.branch_name_en, bc.contact_person, bc.contact_person_en, bc.phone
    from business_partner_contacts bc
    where bc.business_partner_id = bp.id and bc.is_deleted = false
    order by bc.is_primary desc nulls last, bc.created_at asc
    limit 1
  ) c on true
  where (bp.is_deleted is null or bp.is_deleted = false)
    and (p_category is null or p_category = '' or bp.category = p_category)
    and (
      p_search is null or p_search = '' or
      concat_ws(' ', bp.company_name, bp.company_name_en, c.branch_name, c.branch_name_en,
        c.contact_person, c.contact_person_en, c.phone, bp.company_phone, bp.fax, bp.email, bp.address, bp.notes)
      ilike '%'||p_search||'%'
    )
  order by bp.company_name, bp.id;
$$;

grant execute on function search_business_partners(text, text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
