// Web画面(KIC Travel Core)の「駐車場 今すぐ予約」モーダルから登録された、
// status="即時実行待ち" のSupabaseレコード(parking_reservationsテーブル)を取得し、
// その場で駐車場予約を実行するスクリプト。facility_typeにより新大阪駅バス駐車場/
// 名古屋(大型車両夜間宿泊予約システム)/広島(中央公園バス駐車場)のいずれの
// 自動化処理を使うか振り分ける。
//
// VercelにデプロイされたWeb画面からは直接Playwrightを実行できない（サーバーレス環境の制約）
// ため、このスクリプトはJUNさんのPCで手動実行する想定。cron等での定期実行にも利用できる。
//
// 実行方法: node book-parking-now.js
//
// 使用するSupabaseの接続情報は、index.html（クライアント側）に埋め込まれているものと
// 同じpublishable(anon)キーを使用する（既にWeb上で公開されている情報であり、新たな秘匿情報
// ではない）。config.json/nagoya-config.json/hiroshima-config.jsonにはそれぞれのサイトの
// ログイン情報のみを保持する。
const HEADLESS = false;

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { loadConfig } = require('./lib/config-store');
const { login, processReservation, logError } = require('./lib/booking-flow');
const { login: loginNagoya, processNagoyaDateReservation, logError: logErrorNagoya } = require('./lib/nagoya-booking-flow');
const { login: loginHiroshima, processReservation: processHiroshimaReservation, logError: logErrorHiroshima } = require('./lib/hiroshima-booking-flow');

const SUPABASE_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

const NAGOYA_CONFIG_PATH = path.join(__dirname, 'nagoya-config.json');
const HIROSHIMA_CONFIG_PATH = path.join(__dirname, 'hiroshima-config.json');

const STATUS_WAITING = '即時実行待ち';
const STATUS_RUNNING = '実行中';
const STATUS_DONE = '完了';
const STATUS_FAILED = '失敗';

function loadNagoyaConfig() {
  if (!fs.existsSync(NAGOYA_CONFIG_PATH)) {
    throw new Error(`nagoya-config.jsonが見つかりません: ${NAGOYA_CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(NAGOYA_CONFIG_PATH, 'utf8'));
}

function loadHiroshimaConfig() {
  if (!fs.existsSync(HIROSHIMA_CONFIG_PATH)) {
    throw new Error(`hiroshima-config.jsonが見つかりません: ${HIROSHIMA_CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(HIROSHIMA_CONFIG_PATH, 'utf8'));
}

async function markRunning(sb, id) {
  await sb.from('parking_reservations').update({ status: STATUS_RUNNING, updated_at: new Date().toISOString() }).eq('id', id);
}
async function markDone(sb, id, resultMessage, screenshotPath) {
  await sb.from('parking_reservations').update({
    status: STATUS_DONE, result_message: resultMessage, screenshot_path: screenshotPath, updated_at: new Date().toISOString(),
  }).eq('id', id);
}
async function markFailed(sb, id, message) {
  await sb.from('parking_reservations').update({
    status: STATUS_FAILED, result_message: message, updated_at: new Date().toISOString(),
  }).eq('id', id);
}

async function processShinosakaBatch(sb, records) {
  const config = loadConfig();
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 200 : 0 });
  const page = await browser.newPage();

  try {
    await login(page, config.loginId, config.loginPassword);
    console.log('[新大阪] ログイン成功');
  } catch (e) {
    console.error('[新大阪] ログインに失敗したため、この施設分の処理を中止します:', e.message);
    logError(`[即時実行] ログイン失敗: ${e.message}`);
    await browser.close();
    return;
  }

  for (const record of records) {
    console.log(`--- [新大阪] REF#${record.ref_no}（id=${record.id}）の予約処理を開始します ---`);
    await markRunning(sb, record.id);

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
      await markDone(sb, record.id, '予約完了', result.screenshotPath);
      console.log(`✓ REF#${record.ref_no} 予約完了。スクリーンショット: ${result.screenshotPath}`);
    } catch (e) {
      await markFailed(sb, record.id, e.message);
      console.error(`✗ REF#${record.ref_no} 予約失敗: ${e.message}`);
      logError(`[即時実行] REF#${record.ref_no}（id=${record.id}） 予約失敗: ${e.message}\n${e.stack || ''}`);
    }
  }

  await browser.close();
}

async function processNagoyaBatch(sb, records) {
  let config;
  try {
    config = loadNagoyaConfig();
  } catch (e) {
    console.error('[名古屋] 設定の読み込みに失敗したため、この施設分の処理をスキップします:', e.message);
    for (const record of records) await markFailed(sb, record.id, e.message);
    return;
  }

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 200 : 0 });
  const page = await browser.newPage();

  try {
    await loginNagoya(page, config.loginId, config.loginPassword);
    console.log('[名古屋] ログイン成功');
  } catch (e) {
    console.error('[名古屋] ログインに失敗したため、この施設分の処理を中止します:', e.message);
    logErrorNagoya(`[即時実行] ログイン失敗: ${e.message}`);
    await browser.close();
    return;
  }

  for (const record of records) {
    console.log(`--- [名古屋] REF#${record.ref_no}（id=${record.id}）の予約処理を開始します ---`);
    await markRunning(sb, record.id);

    const extra = record.extra || {};
    const dateISO = String(record.start_datetime).slice(0, 10);
    const vehicle = {
      inTime: String(record.start_datetime).slice(11, 16),
      outTime: String(record.end_datetime).slice(11, 16),
      vehicleType: '大型',
      busCompanyName: extra.bus_company_name,
      driverName: extra.driver_name,
      driverHotelName: extra.driver_hotel_name,
      contactPhone: extra.contact_phone,
      applicantName: extra.applicant_name,
      carNumber: record.car_number,
    };

    try {
      const result = await processNagoyaDateReservation(page, dateISO, [vehicle], record.facility_area, null);
      await markDone(sb, record.id, `予約完了（${result.facilityUsed}）`, result.screenshotPath);
      console.log(`✓ REF#${record.ref_no} 予約完了（${result.facilityUsed}）。スクリーンショット: ${result.screenshotPath}`);
    } catch (e) {
      await markFailed(sb, record.id, e.message);
      console.error(`✗ REF#${record.ref_no} 予約失敗: ${e.message}`);
      logErrorNagoya(`[即時実行] REF#${record.ref_no}（id=${record.id}） 予約失敗: ${e.message}\n${e.stack || ''}`);
    }
  }

  await browser.close();
}

async function processHiroshimaBatch(sb, records) {
  let config;
  try {
    config = loadHiroshimaConfig();
  } catch (e) {
    console.error('[広島] 設定の読み込みに失敗したため、この施設分の処理をスキップします:', e.message);
    for (const record of records) await markFailed(sb, record.id, e.message);
    return;
  }

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 200 : 0 });
  const page = await browser.newPage();

  try {
    await loginHiroshima(page, config.email, config.password);
    console.log('[広島] ログイン成功');
  } catch (e) {
    console.error('[広島] ログインに失敗したため、この施設分の処理を中止します:', e.message);
    logErrorHiroshima(`[即時実行] ログイン失敗: ${e.message}`);
    await browser.close();
    return;
  }

  for (const record of records) {
    console.log(`--- [広島] REF#${record.ref_no}（id=${record.id}）の予約処理を開始します ---`);
    await markRunning(sb, record.id);

    const extra = record.extra || {};
    const reservation = {
      refNumber: record.ref_no,
      startDateTime: record.start_datetime,
      endDateTime: record.end_datetime,
      busCount: extra.bus_count,
      busType: extra.bus_type,
      contactName: extra.contact_name,
      contactTel: extra.contact_tel,
      busCompany: extra.bus_company,
      passengers: extra.passengers,
      customer: extra.customer,
      destinations: extra.destinations,
      remarks: record.remarks,
    };

    try {
      const result = await processHiroshimaReservation(page, reservation);
      await markDone(sb, record.id, '予約完了', result.screenshotPath);
      console.log(`✓ REF#${record.ref_no} 予約完了。スクリーンショット: ${result.screenshotPath}`);
    } catch (e) {
      await markFailed(sb, record.id, e.message);
      console.error(`✗ REF#${record.ref_no} 予約失敗: ${e.message}`);
      logErrorHiroshima(`[即時実行] REF#${record.ref_no}（id=${record.id}） 予約失敗: ${e.message}\n${e.stack || ''}`);
    }
  }

  await browser.close();
}

async function main() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

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

  const shinosakaTargets = targets.filter((r) => (r.facility_type || 'shinosaka') === 'shinosaka');
  const nagoyaTargets = targets.filter((r) => r.facility_type === 'nagoya');
  const hiroshimaTargets = targets.filter((r) => r.facility_type === 'hiroshima');

  console.log(`即時実行待ち: ${targets.length}件（新大阪: ${shinosakaTargets.length}件 / 名古屋: ${nagoyaTargets.length}件 / 広島: ${hiroshimaTargets.length}件）`);

  if (shinosakaTargets.length) await processShinosakaBatch(sb, shinosakaTargets);
  if (nagoyaTargets.length) await processNagoyaBatch(sb, nagoyaTargets);
  if (hiroshimaTargets.length) await processHiroshimaBatch(sb, hiroshimaTargets);

  console.log('即時実行待ちの予約すべての処理が完了しました。');
}

main().catch((e) => {
  console.error('予期しないエラーが発生しました:', e);
  logError(`[即時実行] 予期しないエラー: ${e.message}\n${e.stack || ''}`);
  process.exit(1);
});
