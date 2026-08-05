// F1事前調査: estimation_fit_itemsテーブルの実データ件数を確認する読み取り専用スクリプト。
// メイン保存処理(saveEstimation)にこのテーブルへのinsert経路が見当たらず、コード上は
// copyEstimation/deleteEstimationでの削除対象にしか登場しないため、実際にデータが
// 残っているか(=移行対象に含めるべきか)を確認する。実際の変更は一切行わない。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/check_estimation_fit_items_count.js

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
  || 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

async function countRows(table){
  const res = await fetch(`${SB_URL}/rest/v1/${table}?select=id&limit=1`, {
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      Prefer: 'count=exact',
    },
  });
  if(!res.ok){
    return { error: `${res.status} ${await res.text()}` };
  }
  const range = res.headers.get('content-range'); // 例: "0-0/123"
  const total = range && range.includes('/') ? range.split('/')[1] : null;
  return { total };
}

async function main(){
  const tables = ['estimation_fit_items', 'estimations', 'estimation_days', 'estimation_fixed_rows', 'estimation_booking_reflections'];
  const results = {};
  for(const t of tables){
    results[t] = await countRows(t);
  }
  console.log('\n=== 各テーブルの件数(参考: estimations等も比較用に併記) ===');
  console.table(Object.entries(results).map(([table, r]) => ({ table, 件数: r.total ?? '(取得失敗)', エラー: r.error || '' })));

  if(results.estimation_fit_items && results.estimation_fit_items.total !== null){
    if(Number(results.estimation_fit_items.total) === 0){
      console.log('\nestimation_fit_itemsは0件でした。使われていない(または既にデータが無い)可能性が高いです。');
    }else{
      console.log(`\nestimation_fit_itemsに${results.estimation_fit_items.total}件のデータが存在します。実際に使われているか、サンプルを確認することを推奨します。`);
      const sample = await fetch(`${SB_URL}/rest/v1/estimation_fit_items?select=*&limit=5`, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      }).then(r=>r.json()).catch(()=>null);
      if(sample) console.log('\nサンプル5件:', JSON.stringify(sample, null, 2));
    }
  }

  console.log('\n※このスクリプトは読み取りのみ。実際の変更は一切行っていません。');
}

main().catch(e => { console.error(e); process.exit(1); });
