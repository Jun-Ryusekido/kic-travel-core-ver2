// クレジットカード明細機能の再設計に伴う、過去データ(booking_costs.memoへの手打ち
// 「法人カード」「個人カード」)の新しいpayment_method構造への移行プレビュー。
//
// index.htmlのopenCcPaymentMigrationPreview()と全く同じ抽出・分類条件を、
// Node側から実行して詳細を出力する読み取り専用スクリプト(実際のUPDATEは一切行わない)。
//
// 抽出条件: booking_costs.payment_methodが未設定(null) かつ memoに「カード」を含む行。
// 分類条件:
//   - 法人カード変換候補: memoに「法人カード」を含み、かつ「個人カード」を含まない
//   - 個人カード変換候補: memoに「個人カード」を含む
//   - 判定できず対象外: 上記どちらにも該当しない(現状のまま残す)
//
// 出力内容:
//   1. 全体件数・分類ごとの件数
//   2. 法人カード候補: 金額の分布(帯ごとの件数・合計)、代表サンプル20件(memo全文つき)
//   3. 個人カード候補: 全件の詳細(REF#・仕入先名・金額・memo全文)
//   4. 判定できず対象外の件数(参考。中身は出力しない)
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/preview_cc_payment_method_migration.js
//   (読み取りのみのため、他のスクリプトと同じ規約で読み取り専用のanonキーでも動作するが、
//    booking_costs.memoは仕入明細の内容を含むため、既定ではSUPABASE_SERVICE_ROLE_KEYを推奨)

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

function amountBand(amount){
  const a = Number(amount) || 0;
  if(a < 10000) return '〜9,999円';
  if(a < 30000) return '10,000〜29,999円';
  if(a < 50000) return '30,000〜49,999円';
  if(a < 100000) return '50,000〜99,999円';
  if(a < 300000) return '100,000〜299,999円';
  return '300,000円〜';
}

async function main(){
  const bookings = await sbSelect('bookings', 'select=id,ref_no,agent_name,tour_name');
  const bookingById = new Map(bookings.map(b => [b.id, b]));

  const rows = [];
  const PAGE_SIZE = 1000;
  for(let page = 0; page < 10; page++){
    const data = await sbSelect(
      'booking_costs',
      `select=id,booking_id,item_name,amount,memo,payment_method&payment_method=is.null&memo=ilike.*カード*&order=id&offset=${page*PAGE_SIZE}&limit=${PAGE_SIZE}`
    );
    rows.push(...data);
    if(data.length < PAGE_SIZE) break;
  }

  const corporate = rows.filter(r => (r.memo||'').includes('法人カード') && !(r.memo||'').includes('個人カード'));
  const personal = rows.filter(r => (r.memo||'').includes('個人カード'));
  const classifiedIds = new Set([...corporate, ...personal].map(r => r.id));
  const unclassified = rows.filter(r => !classifiedIds.has(r.id));

  console.log(`\n=== 全体件数 ===`);
  console.log(`payment_method未設定 かつ memoに「カード」を含む: ${rows.length}件`);
  console.log(`  法人カード変換候補: ${corporate.length}件`);
  console.log(`  個人カード変換候補: ${personal.length}件`);
  console.log(`  判定できず対象外: ${unclassified.length}件`);

  // --- 法人カード: 金額分布 ---
  const bandOrder = ['〜9,999円','10,000〜29,999円','30,000〜49,999円','50,000〜99,999円','100,000〜299,999円','300,000円〜'];
  const bandStats = {};
  bandOrder.forEach(b => { bandStats[b] = { count: 0, sum: 0 }; });
  corporate.forEach(r => {
    const b = amountBand(r.amount);
    bandStats[b].count++;
    bandStats[b].sum += Number(r.amount) || 0;
  });
  console.log(`\n=== 法人カード候補(${corporate.length}件)の金額分布 ===`);
  console.table(bandOrder.map(b => ({ 金額帯: b, 件数: bandStats[b].count, 合計: bandStats[b].sum })));
  const corpTotal = corporate.reduce((s, r) => s + (Number(r.amount)||0), 0);
  console.log(`法人カード候補 合計金額: ${corpTotal.toLocaleString()}円`);

  // --- 法人カード: サンプル20件(memo全文つき) ---
  const sampleSize = 20;
  const step = Math.max(1, Math.floor(corporate.length / sampleSize));
  const sample = [];
  for(let i = 0; i < corporate.length && sample.length < sampleSize; i += step){
    sample.push(corporate[i]);
  }
  console.log(`\n=== 法人カード候補 サンプル${sample.length}件(全体から均等抽出、memo全文つき) ===`);
  console.log(JSON.stringify(sample.map(r => {
    const b = bookingById.get(r.booking_id);
    return {
      ref_no: b ? b.ref_no : r.booking_id,
      item_name: r.item_name,
      amount: r.amount,
      memo: r.memo,
    };
  }), null, 2));

  // --- 個人カード: 全件詳細 ---
  console.log(`\n=== 個人カード候補 全${personal.length}件の詳細 ===`);
  console.log(JSON.stringify(personal.map(r => {
    const b = bookingById.get(r.booking_id);
    return {
      ref_no: b ? b.ref_no : r.booking_id,
      booking_id: r.booking_id,
      item_name: r.item_name,
      amount: r.amount,
      memo: r.memo,
    };
  }), null, 2));

  console.log('\n※このスクリプトは読み取りのみ。実際のUPDATEは一切行っていません。');
}

main().catch(e => { console.error(e); process.exit(1); });
