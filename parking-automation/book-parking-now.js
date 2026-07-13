// Web画面(KIC Travel Core)の「駐車場 今すぐ予約」モーダルから登録された、
// status="即時実行待ち" のSupabaseレコード(parking_reservationsテーブル)を取得し、
// その場で新大阪駅バス駐車場の予約を実行するスクリプト。
//
// VercelにデプロイされたWeb画面からは直接Playwrightを実行できない（サーバーレス環境の制約）
// ため、このスクリプトはJUNさんのPCで手動実行する想定。cron等での定期実行にも利用できる。
//
// 実行方法: node book-parking-now.js
//
// 使用するSupabaseの接続情報は、index.html（クライアント側）に埋め込まれているものと
// 同じpublishable(anon)キーを使用する（既にWeb上で公開されている情報であり、新たな秘匿情報
// ではない）。config.jsonにはサイトのログイン情報のみを保持する。
const HEADLESS = false;

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { loadConfig } = require('./lib/config-store');
const { login, processReservation, logError } = require('./lib/booking-flow');

const SUPABASE_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

const STATUS_WAITING = '即時実行待ち';
const STATUS_RUNNING = '実行中';
const STATUS_DONE = '完了';
const STATUS_FAILED = '失敗';

async function main() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const config = loadConfig();

  console.log('Supabaseから即時実行待ちの予約を取得します...');
  const { data: targets, error: fetchError } = await sb
    .from('parking_reservations')
    .select('*')
    .eq('status', STATUS_WAITING)
    .order('created_at', { ascending: true });

  if (fetchError) {
    console.error('Supabaseからの取得に失敗しました:', fetchError.message);
    logError(`[即時実行] Supabase取得エラー: ${fetchError.message}`);
    process.exit(1);
  }

  if (!targets || targets.length === 0) {
    console.log('即時実行待ちの予約はありません。処理を終了します。');
    return;
  }

  console.log(`即時実行待ち: ${targets.length}件`);

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 200 : 0 });
  const page = await browser.newPage();

  try {
    await login(page, config.loginId, config.loginPassword);
    console.log('ログイン成功');
  } catch (e) {
    console.error('ログインに失敗したため、処理を中止します:', e.message);
    logError(`[即時実行] ログイン失敗: ${e.message}`);
    await browser.close();
    return;
  }

  for (const record of targets) {
    console.log(`--- REF#${record.ref_no}（id=${record.id}）の予約処理を開始します ---`);

    // 他プロセス・多重実行との競合を避けるため、処理開始時点で「実行中」に更新する
    await sb.from('parking_reservations').update({ status: STATUS_RUNNING, updated_at: new Date().toISOString() }).eq('id', record.id);

    const reservation = {
      refNumber: record.ref_no,
      facilityArea: record.facility_area,
      startDateTime: record.start_datetime,
      endDateTime: record.end_datetime,
      carNumber: record.car_number,
      remarks: record.remarks,
      paymentMethod: record.payment_method,
    };

    try {
      const result = await processReservation(page, reservation);
      await sb.from('parking_reservations').update({
        status: STATUS_DONE,
        result_message: '予約完了',
        screenshot_path: result.screenshotPath,
        updated_at: new Date().toISOString(),
      }).eq('id', record.id);
      console.log(`✓ REF#${record.ref_no} 予約完了。スクリーンショット: ${result.screenshotPath}`);
    } catch (e) {
      await sb.from('parking_reservations').update({
        status: STATUS_FAILED,
        result_message: e.message,
        updated_at: new Date().toISOString(),
      }).eq('id', record.id);
      console.error(`✗ REF#${record.ref_no} 予約失敗: ${e.message}`);
      logError(`[即時実行] REF#${record.ref_no}（id=${record.id}） 予約失敗: ${e.message}\n${e.stack || ''}`);
    }
  }

  await browser.close();
  console.log('即時実行待ちの予約すべての処理が完了しました。');
}

main().catch((e) => {
  console.error('予期しないエラーが発生しました:', e);
  logError(`[即時実行] 予期しないエラー: ${e.message}\n${e.stack || ''}`);
  process.exit(1);
});
