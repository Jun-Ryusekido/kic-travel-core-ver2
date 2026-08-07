// Web画面(KIC Travel Core)の「駐車場 今すぐ予約」モーダルから登録された、
// status="即時実行待ち" のSupabaseレコード(parking_reservationsテーブル)を取得し、
// その場で駐車場予約を実行するスクリプト。facility_typeにより新大阪駅バス駐車場/
// 名古屋(大型車両夜間宿泊予約システム)/広島(中央公園バス駐車場)のいずれの
// 自動化処理を使うか振り分ける。
//
// VercelにデプロイされたWeb画面からは直接Playwrightを実行できない（サーバーレス環境の制約）
// ため、このスクリプトはJUNさんのPCで手動実行する想定。cron等での定期実行にも利用できる。
//
// 実行方法(PowerShell):
//   $env:SUPABASE_SERVICE_ROLE_KEY="xxxx"; node parking-automation\book-parking-now.js
// 実行方法(コマンドプロンプト):
//   set SUPABASE_SERVICE_ROLE_KEY=xxxx && node parking-automation\book-parking-now.js
//
// parking_reservationsはscripts/lock_down_parking_reservations.sqlにより、anon/authenticated
// ロールからの直接アクセスを完全に遮断済み(支払方法・車両ナンバー・運転手氏名・連絡先電話番号等の
// 機微情報を含むため)。Web画面側(index.html)はservice_role keyを使うサーバーレス関数
// (/api/table-crud)経由に既に切り替わっているが、このスクリプトはローカルでJUNさんが直接
// 実行するものであり、ブラウザに公開されることが無いためservice_role keyを直接環境変数から
// 読み込む(scripts/apply_access_booking_merge.js等、他の管理スクリプトと同じパターン)。
// config.json/nagoya-config.json/hiroshima-config.jsonにはそれぞれのサイトのログイン情報のみを
// 保持する（Supabase接続情報とは別の秘匿情報のため使い分けている）。
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
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

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
      const result = await processNagoyaDateReservation(page, dateISO, [vehicle], record.facility_area, null, config.loginId, config.loginPassword);
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
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('環境変数 SUPABASE_SERVICE_ROLE_KEY が設定されていません。');
    console.error('parking_reservationsへのアクセスはservice_role keyが必須です(anonキーでは' +
      'lock_down_parking_reservations.sql適用後アクセスできません)。');
    process.exitCode = 1;
    return;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  console.log('Supabaseから即時実行待ちの予約を取得します...');
  const { data: targets, error: fetchError } = await sb
    .from('parking_reservations')
    .select('*')
    .eq('status', STATUS_WAITING)
    .order('created_at', { ascending: true });

  if (fetchError) {
    console.error('Supabaseからの取得に失敗しました:', fetchError.message);
    logError(`[即時実行] Supabase取得エラー: ${fetchError.message}`);
    process.exitCode = 1;
    return;
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
  process.exitCode = 1;
});
