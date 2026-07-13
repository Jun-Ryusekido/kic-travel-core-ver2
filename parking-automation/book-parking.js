// 新大阪駅バス駐車場の予約を自動化する本番スクリプト。
// config.json の reservations のうち、status="pending" かつ
// (startDateTimeの日付 - advanceDays) が「今日(JST)」と一致するものだけを処理する。
//
// 実行方法: node book-parking.js
//
// 最初はHEADLESSをfalseにしたまま実行し、実際の画面の動きを目視確認してください。
// 動作確認が取れたら、下のHEADLESSをtrueに変更してください（cron等での無人実行時はtrue推奨）。
const HEADLESS = false;

const { chromium } = require('playwright');
const { loadConfig, saveConfig } = require('./lib/config-store');
const { getTodayJST, subtractDays } = require('./lib/date-utils');
const { login, processReservation, logError } = require('./lib/booking-flow');

async function main() {
  const config = loadConfig();
  const today = getTodayJST();

  const targets = config.reservations.filter((r) => {
    if (r.status !== 'pending') return false;
    const execDate = subtractDays(r.startDateTime.slice(0, 10), r.advanceDays);
    return execDate === today;
  });

  if (targets.length === 0) {
    console.log(`[${new Date().toISOString()}] 本日(${today})実行対象の予約はありません。処理を終了します。`);
    return;
  }

  console.log(`本日(${today})実行対象: ${targets.length}件`);

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 200 : 0 });
  const page = await browser.newPage();

  try {
    await login(page, config.loginId, config.loginPassword);
    console.log('ログイン成功');
  } catch (e) {
    console.error('ログインに失敗したため、処理を中止します:', e.message);
    logError(`ログイン失敗: ${e.message}`);
    await browser.close();
    return;
  }

  for (const reservation of targets) {
    console.log(`--- REF#${reservation.refNumber} の予約処理を開始します ---`);
    try {
      const result = await processReservation(page, reservation);
      reservation.status = 'completed';
      console.log(`✓ REF#${reservation.refNumber} 予約完了。スクリーンショット: ${result.screenshotPath}`);
    } catch (e) {
      reservation.status = 'failed';
      console.error(`✗ REF#${reservation.refNumber} 予約失敗: ${e.message}`);
      logError(`REF#${reservation.refNumber} 予約失敗: ${e.message}\n${e.stack || ''}`);
    }
    saveConfig(config); // 1件ごとに保存し、途中でスクリプトが落ちても進捗が失われないようにする
  }

  await browser.close();
  console.log('全ての対象予約の処理が完了しました。');
}

main().catch((e) => {
  console.error('予期しないエラーが発生しました:', e);
  logError(`予期しないエラー: ${e.message}\n${e.stack || ''}`);
  process.exit(1);
});
