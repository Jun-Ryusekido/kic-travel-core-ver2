// 京都テルサ 大型バス駐車場（reserva.be/kyototerrsaparking）の自動予約スクリプト。
//
// 実行方法:
//   node parking-kyoto-terrsa.js --date 2026-10-14 --vehicles 2
//   node parking-kyoto-terrsa.js --date 2026-10-14 --vehicles 2 --wait-until-available
//
// 【注意】このスクリプトを実行すると実際に駐車場の予約枠を確定させます（--vehicles分の台数）。
//
// ログイン情報は .env の KYOTO_TERRSA_LOGIN_ID / KYOTO_TERRSA_PASSWORD から読み込みます
// （.env はgit管理外。.env.example を参考に自分で作成してください）。
// 予約サイトはCloudflareのボット対策があり、headless:trueだと検証ページで止まってしまうため
// 必ずheadless:falseで実行してください（下記のHEADLESSは変更しないこと）。
//
// このサイトの予約フォームには「台数」を指定する項目が無く、1回の予約操作で1台分しか
// 確保できないことを実際の画面で確認済み（"オプション"欄の"夜間予約マイクロ・小型バス（車種変更）"は
// 車種変更用の別項目であり、台数指定ではない）。そのため--vehiclesで指定した台数分、
// 同一ブラウザセッション内で予約フローを連続実行することで対応する。
const HEADLESS = false;

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { getTodayJST, subtractMonths } = require('./lib/date-utils');
const {
  login,
  processKyotoTerrsaReservation,
  waitForDateAvailable,
  logError,
  LOGS_DIR,
} = require('./lib/kyoto-terrsa-booking-flow');

const SUPABASE_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

const BOOKING_WINDOW_MONTHS = 3; // 予約受付開始：利用日の3ヶ月前の00:00から
const UTILIZATION_GROUP = 'KIC0000';
const BUS_COMPANY_NAME = 'KICトラベル';
const RETRY_INTERVAL_MS = 2500; // 解禁待ちリトライの間隔（回線負荷を抑えるため2〜3秒程度）
const RETRY_MAX_WAIT_MS = 20 * 60 * 1000; // 解禁待ちの最大待機時間（20分）

function parseArgs(argv) {
  const args = { vehicles: 1, waitUntilAvailable: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date' && argv[i + 1]) { args.date = argv[i + 1]; i++; }
    else if (argv[i] === '--vehicles' && argv[i + 1]) { args.vehicles = Number(argv[i + 1]); i++; }
    else if (argv[i] === '--wait-until-available') { args.waitUntilAvailable = true; }
  }
  return args;
}

function nextDateISO(dateISO) {
  const d = new Date(dateISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function recordResult(sb, { dateISO, vehicleIndex, totalVehicles, status, resultMessage, screenshotPath }) {
  const refSuffix = totalVehicles > 1 ? `-${vehicleIndex}` : '';
  const payload = {
    facility_type: 'kyoto_terrsa',
    ref_no: `KYOTO-${dateISO}${refSuffix}`,
    facility_area: '京都テルサ大型バス駐車場',
    start_datetime: `${dateISO}T18:00:00`,
    end_datetime: `${nextDateISO(dateISO)}T08:00:00`,
    status,
    result_message: resultMessage || null,
    screenshot_path: screenshotPath || null,
    extra: {
      utilization_group: UTILIZATION_GROUP,
      bus_company_name: BUS_COMPANY_NAME,
      vehicle_index: vehicleIndex,
      total_vehicles: totalVehicles,
    },
  };
  const { error } = await sb.from('parking_reservations').insert(payload);
  if (error) {
    console.error('Supabaseへの結果記録に失敗しました:', error.message);
    logError(`[記録失敗] ${dateISO} (${vehicleIndex}/${totalVehicles}): ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error('使い方: node parking-kyoto-terrsa.js --date YYYY-MM-DD [--vehicles N] [--wait-until-available]');
    process.exit(1);
  }
  if (!Number.isInteger(args.vehicles) || args.vehicles < 1) {
    console.error('--vehicles には1以上の整数を指定してください');
    process.exit(1);
  }
  const dateISO = args.date;
  const totalVehicles = args.vehicles;

  const loginId = process.env.KYOTO_TERRSA_LOGIN_ID;
  const password = process.env.KYOTO_TERRSA_PASSWORD;
  if (!loginId || !password) {
    console.error('.envにKYOTO_TERRSA_LOGIN_ID / KYOTO_TERRSA_PASSWORDを設定してください（.env.exampleを参照）。');
    process.exit(1);
  }

  // 予約受付開始（3ヶ月前の00:00）のチェック
  const today = getTodayJST();
  const openDate = subtractMonths(dateISO, BOOKING_WINDOW_MONTHS);
  if (today < openDate && !args.waitUntilAvailable) {
    console.error(`対象日(${dateISO})はまだ予約受付開始前です（受付開始日: ${openDate}）。処理を終了します。`);
    console.error('解禁待ちでリトライしたい場合は --wait-until-available を付けて実行してください。');
    process.exit(1);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 200 : 0 });
  const page = await browser.newPage();
  const startedAt = Date.now();
  const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1);

  try {
    await login(page, loginId, password);
    console.log(`ログイン成功（${elapsed()}秒経過）`);
  } catch (e) {
    console.error('ログインに失敗したため、処理を中止します:', e.message);
    logError(`ログイン失敗: ${e.message}`);
    for (let v = 1; v <= totalVehicles; v++) {
      await recordResult(sb, { dateISO, vehicleIndex: v, totalVehicles, status: '失敗', resultMessage: e.message });
    }
    await browser.close();
    process.exit(1);
  }

  if (args.waitUntilAvailable) {
    console.log(`対象日(${dateISO})が選択可能になるまで${RETRY_INTERVAL_MS / 1000}秒間隔でリトライします（最大${RETRY_MAX_WAIT_MS / 60000}分）...`);
    const available = await waitForDateAvailable(page, dateISO, {
      intervalMs: RETRY_INTERVAL_MS,
      maxWaitMs: RETRY_MAX_WAIT_MS,
      onTick: ({ attempt, available, elapsedMs }) => {
        console.log(`  [試行${attempt}] ${(elapsedMs / 1000).toFixed(1)}秒経過 - ${available ? '選択可能になりました' : 'まだ選択できません'}`);
      },
    });
    if (!available) {
      const msg = `対象日(${dateISO})が制限時間内に選択可能になりませんでした`;
      console.error(msg);
      logError(msg);
      for (let v = 1; v <= totalVehicles; v++) {
        await recordResult(sb, { dateISO, vehicleIndex: v, totalVehicles, status: '失敗', resultMessage: msg });
      }
      await browser.close();
      process.exit(1);
    }
    console.log(`対象日(${dateISO})が選択可能になりました（${elapsed()}秒経過）。予約処理を開始します。`);
  }

  const results = [];
  for (let v = 1; v <= totalVehicles; v++) {
    try {
      const result = await processKyotoTerrsaReservation(page, dateISO, UTILIZATION_GROUP, BUS_COMPANY_NAME, totalVehicles > 1 ? v : undefined);
      console.log(`✓ [${v}/${totalVehicles}台目] ${dateISO} 予約完了。確認番号: ${result.confirmationNumber || '(画面上に見つかりませんでした)'}（${elapsed()}秒経過）`);
      console.log(`  スクリーンショット: ${result.screenshotPath}`);
      results.push({ vehicleIndex: v, status: '完了', confirmationNumber: result.confirmationNumber, screenshotPath: result.screenshotPath });
      await recordResult(sb, {
        dateISO,
        vehicleIndex: v,
        totalVehicles,
        status: '完了',
        resultMessage: result.confirmationNumber ? `確認番号: ${result.confirmationNumber}` : '予約完了（確認番号は画面上に見つかりませんでした）',
        screenshotPath: result.screenshotPath,
      });
    } catch (e) {
      console.error(`✗ [${v}/${totalVehicles}台目] ${dateISO} 予約失敗: ${e.message}（${elapsed()}秒経過）`);
      logError(`${dateISO} (${v}/${totalVehicles}) 予約失敗: ${e.message}\n${e.stack || ''}`);
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      const errShot = path.join(LOGS_DIR, `kyoto-terrsa-${dateISO}-v${v}-error-${Date.now()}.png`);
      await page.screenshot({ path: errShot, fullPage: true }).catch(() => null);
      results.push({ vehicleIndex: v, status: '失敗', resultMessage: e.message, screenshotPath: errShot });
      await recordResult(sb, { dateISO, vehicleIndex: v, totalVehicles, status: '失敗', resultMessage: e.message, screenshotPath: errShot });
    }
  }

  await browser.close();

  const successCount = results.filter((r) => r.status === '完了').length;
  console.log('\n===== 結果まとめ =====');
  console.log(`対象日: ${dateISO} / 台数: ${totalVehicles} / 成功: ${successCount} / 失敗: ${totalVehicles - successCount}`);
  results.forEach((r) => {
    console.log(`  ${r.vehicleIndex}台目: [${r.status}] ${r.confirmationNumber ? '確認番号=' + r.confirmationNumber : r.resultMessage || ''}`);
  });
  console.log(`総実行時間: ${elapsed()}秒`);

  if (successCount < totalVehicles) process.exit(1);
}

main().catch((e) => {
  console.error('予期しないエラーが発生しました:', e);
  logError(`予期しないエラー: ${e.message}\n${e.stack || ''}`);
  process.exit(1);
});
