// 【実行に必要な環境変数】SUPABASE_SERVICE_ROLE_KEY(必須。anonキーでは実行できない)
//   値の取得: Supabase管理画面 > Project Settings > API Keys > service_role(secret)
//   設定・実行(PowerShell): $env:SUPABASE_SERVICE_ROLE_KEY="<値>"; node scripts/check_estimation_fit_items_count.js
//   設定・実行(bash):       SUPABASE_SERVICE_ROLE_KEY=<値> node scripts/check_estimation_fit_items_count.js
//   キーはファイルに書かずコミットしないこと。未設定時はanonキーにフォールバックせずエラー終了する
//   (2026-09 RLS対応フェーズ1で全スクリプトをservice_role必須に統一)。
// F1事前調査: estimation_fit_itemsテーブルの実データ件数を確認する読み取り専用スクリプト。
// メイン保存処理(saveEstimation)にこのテーブルへのinsert経路が見当たらず、コード上は
// copyEstimation/deleteEstimationでの削除対象にしか登場しないため、実際にデータが
// 残っているか(=移行対象に含めるべきか)を確認する。実際の変更は一切行わない。
//
// 実行方法:
//   SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/check_estimation_fit_items_count.js

const SB_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
function requireServiceRoleKey(key) {
  if (!key) {
    console.error('SUPABASE_SERVICE_ROLE_KEYが未設定です。anonでは実行できません(anonキーはRLS有効化・権限剥奪によりテーブルを読み書きできず、空の結果による誤判定や書き込み失敗の原因になるため)。ファイル冒頭の【実行に必要な環境変数】の手順で設定してから再実行してください。');
    process.exit(1);
  }
}
requireServiceRoleKey(SB_KEY);

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
