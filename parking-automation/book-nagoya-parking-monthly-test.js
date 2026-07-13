// book-nagoya-parking-monthly.js の動作確認用テスト版。
// 月全体・複数台をまとめて処理する本番スクリプトとは異なり、
// nagoya-config.json の "testSingleDate" に指定した1日・1台だけを予約する。
// 初めて本番スクリプトを使う前に、まずこちらで一連の流れ（入力→確認・承認→予約確定）
// が正しく動作することを確認するためのもの。
//
// 実行方法: node book-nagoya-parking-monthly-test.js
//
// 【注意】このテストは実際に対象日の駐車場予約枠を1件確定させます。
const HEADLESS = false;

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { login, processNagoyaDateReservation, logError } = require('./lib/nagoya-booking-flow');

const CONFIG_PATH = path.join(__dirname, 'nagoya-config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`nagoya-config.jsonが見つかりません: ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

async function main() {
  const config = loadConfig();
  if (!config.testSingleDate) {
    console.log('nagoya-config.jsonに"testSingleDate"(例: "2026-08-25")を指定してください。処理を終了します。');
    return;
  }
  const plan = config.defaultPlan;
  const vehicle = {
    inTime: plan.checkInTime,
    outTime: plan.checkOutTime,
    vehicleType: plan.vehicleType,
    busCompanyName: plan.busCompanyName,
    driverName: plan.driverName,
    driverHotelName: plan.driverHotelName,
    contactPhone: plan.contactPhone,
    applicantName: plan.applicantName,
    carNumber: plan.carNumber,
  };

  console.log('==============================================');
  console.log(` テストモードで実行します（1日・1台のみ処理: ${config.testSingleDate}）`);
  console.log('==============================================');

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 200 : 0 });
  const page = await browser.newPage();

  try {
    await login(page, config.loginId, config.loginPassword);
    console.log('ログイン成功');
  } catch (e) {
    console.error('ログインに失敗したため、処理を中止します:', e.message);
    logError(`[月次バッチ・テスト] ログイン失敗: ${e.message}`);
    await browser.close();
    return;
  }

  try {
    const result = await processNagoyaDateReservation(page, config.testSingleDate, [vehicle], plan.primaryFacility, plan.fallbackFacility);
    console.log(`✓ ${config.testSingleDate} 予約完了（${result.facilityUsed}）。スクリーンショット: ${result.screenshotPath}`);
  } catch (e) {
    console.error(`✗ ${config.testSingleDate} 予約失敗: ${e.message}`);
    logError(`[月次バッチ・テスト] ${config.testSingleDate} 予約失敗: ${e.message}\n${e.stack || ''}`);
  }

  await browser.close();
  console.log('テスト実行が完了しました。');
}

main().catch((e) => {
  console.error('予期しないエラーが発生しました:', e);
  logError(`[月次バッチ・テスト] 予期しないエラー: ${e.message}\n${e.stack || ''}`);
  process.exit(1);
});
