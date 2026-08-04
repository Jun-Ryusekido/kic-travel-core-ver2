// クレジットカード明細(credit_card_statements.card_holder)の実際の値を確認する
// 読み取り専用スクリプト。名義人表記の統一(booking_costs.card_holderとの対応表作成)の
// 検討材料として、distinct値と件数の一覧を出力する。実際のUPDATEは一切行わない。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/preview_cc_card_holder_values.js

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
  || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

async function sbSelect(table, query){
  const url = `${SB_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
  });
  if(!res.ok){
    throw new Error(`${table} fetch failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function main(){
  let all = [], from = 0;
  const PAGE = 1000;
  while(true){
    const data = await sbSelect('credit_card_statements', `select=card_holder,amount&offset=${from}&limit=${PAGE}`);
    all = all.concat(data);
    if(data.length < PAGE) break;
    from += PAGE;
  }

  const byHolder = {};
  all.forEach(r => {
    const h = (r.card_holder || '').trim() || '(空欄)';
    if(!byHolder[h]) byHolder[h] = { count: 0, sum: 0 };
    byHolder[h].count++;
    byHolder[h].sum += Number(r.amount) || 0;
  });

  const rows = Object.entries(byHolder)
    .map(([holder, v]) => ({ card_holder: holder, 件数: v.count, 合計金額: v.sum }))
    .sort((a, b) => b.件数 - a.件数);

  console.log(`\n=== credit_card_statements.card_holder のdistinct一覧(全${all.length}件中) ===`);
  console.table(rows);
  console.log('\n※このスクリプトは読み取りのみ。実際の更新は一切行っていません。');
}

main().catch(e => { console.error(e); process.exit(1); });
