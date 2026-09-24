// 【実行に必要な環境変数】SUPABASE_SERVICE_ROLE_KEY(必須。anonキーでは実行できない)
//   値の取得: Supabase管理画面 > Project Settings > API Keys > service_role(secret)
//   設定・実行(PowerShell): $env:SUPABASE_SERVICE_ROLE_KEY="<値>"; node scripts/preview_cc_card_holder_values.js
//   設定・実行(bash):       SUPABASE_SERVICE_ROLE_KEY=<値> node scripts/preview_cc_card_holder_values.js
//   キーはファイルに書かずコミットしないこと。未設定時はanonキーにフォールバックせずエラー終了する
//   (2026-09 RLS対応フェーズ1で全スクリプトをservice_role必須に統一)。
// クレジットカード明細(credit_card_statements.card_holder)の実際の値を確認する
// 読み取り専用スクリプト。名義人表記の統一(booking_costs.card_holderとの対応表作成)の
// 検討材料として、distinct値と件数の一覧を出力する。実際のUPDATEは一切行わない。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/preview_cc_card_holder_values.js

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
function requireServiceRoleKey(key) {
  if (!key) {
    console.error('SUPABASE_SERVICE_ROLE_KEYが未設定です。anonでは実行できません(anonキーはRLS有効化・権限剥奪によりテーブルを読み書きできず、空の結果による誤判定や書き込み失敗の原因になるため)。ファイル冒頭の【実行に必要な環境変数】の手順で設定してから再実行してください。');
    process.exit(1);
  }
}
requireServiceRoleKey(SB_KEY);

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
