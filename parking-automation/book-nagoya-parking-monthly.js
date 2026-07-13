// 名古屋 大型車両夜間宿泊予約システムの月次まとめて自動予約スクリプト。
// 毎月1日 00:00(JST)に実行することを想定（Windows タスクスケジューラ等で登録する）。
// 実行時点から2ヶ月先の月の全日程について、それぞれ vehiclesPerDay 台分の予約を試みる。
// 途中で失敗した日があっても処理を止めず、次の日の予約に進む。最後に成功/失敗の一覧を
// コンソールとログファイルにまとめて出力する。
//
// 実行方法: node book-nagoya-parking-monthly.js
const HEADLESS = false;

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  login,
  processNagoyaDateReservation,
  logError,
  LOGS_DIR,
} = require('./lib/nagoya-booking-flow');
const { addMonthsToTodayJST, allDatesInMonth, dateForFilename } = require('./lib/date-utils');

const CONFIG_PATH = path.join(__dirname, 'nagoya-config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`nagoya-config.jsonが見つかりません: ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function resolvePlanForMonth(config, year, month) {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const override = (config.monthOverrides || {})[key] || {};
  return { ...config.defaultPlan, ...override };
}

function buildVehicles(plan) {
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
  return Array.from({ length: plan.vehiclesPerDay }, () => ({ ...vehicle }));
}

async function main() {
  const config = loadConfig();
  const { year, month } = addMonthsToTodayJST(2);
  const plan = resolvePlanForMonth(config, year, month);
  const dates = allDatesInMonth(year, month);
  const vehicles = buildVehicles(plan);

  console.log(`対象月: ${year}年${month}月（${dates.length}日分、1日あたり${plan.vehiclesPerDay}台）`);
  console.log(`駐車場: ${plan.primaryFacility}（満車時は${plan.fallbackFacility}へ切替）`);

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 150 : 0 });
  const page = await browser.newPage();

  try {
    await login(page, config.loginId, config.loginPassword);
    console.log('ログイン成功');
  } catch (e) {
    console.error('ログインに失敗したため、処理を中止します:', e.message);
    logError(`[月次バッチ] ログイン失敗: ${e.message}`);
    await browser.close();
    return;
  }

  const results = [];
  for (const dateISO of dates) {
    console.log(`--- ${dateISO} の予約処理を開始します ---`);
    try {
      const result = await processNagoyaDateReservation(page, dateISO, vehicles, plan.primaryFacility, plan.fallbackFacility);
      results.push({ date: dateISO, status: '成功', facility: result.facilityUsed, detail: result.screenshotPath });
      console.log(`✓ ${dateISO} 予約完了（${result.facilityUsed}）`);
    } catch (e) {
      results.push({ date: dateISO, status: '失敗', facility: '-', detail: e.message });
      console.error(`✗ ${dateISO} 予約失敗: ${e.message}`);
      logError(`[月次バッチ] ${dateISO} 予約失敗: ${e.message}\n${e.stack || ''}`);
    }
  }

  await browser.close();

  const successCount = results.filter((r) => r.status === '成功').length;
  const failCount = results.length - successCount;
  const summaryLines = [
    `===== 名古屋駐車場 月次予約バッチ結果（${year}年${month}月） =====`,
    `成功: ${successCount}件 / 失敗: ${failCount}件 / 合計: ${results.length}件`,
    ...results.map((r) => `${r.date} [${r.status}] ${r.facility} ${r.status === '失敗' ? '- ' + r.detail : ''}`),
  ];
  const summary = summaryLines.join('\n');
  console.log('\n' + summary);

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const summaryPath = path.join(LOGS_DIR, `nagoya-monthly-summary-${dateForFilename()}.log`);
  fs.writeFileSync(summaryPath, summary + '\n', 'utf8');
  console.log(`\nサマリーを保存しました: ${summaryPath}`);
}

main().catch((e) => {
  console.error('予期しないエラーが発生しました:', e);
  logError(`[月次バッチ] 予期しないエラー: ${e.message}\n${e.stack || ''}`);
  process.exit(1);
});
