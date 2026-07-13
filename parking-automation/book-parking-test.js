// book-parking.js のテスト版。日付条件(advanceDaysによる解禁日判定)を無視し、
// status="pending" の予約を今すぐ全件処理する。動作確認専用。
//
// 実行方法: node book-parking-test.js
//
// テスト実行時は必ずHEADLESSをfalseのままにし、目視で動作を確認してください。
const HEADLESS = false;

const { chromium } = require('playwright');
const { loadConfig, saveConfig } = require('./lib/config-store');
const { login, processReservation, logError } = require('./lib/booking-flow');

async function main() {
  console.log('==============================================');
  console.log(' テストモードで実行します（日付条件は無視します）');
  console.log('==============================================');

  const config = loadConfig();
  const targets = config.reservations.filter((r) => r.status === 'pending');

  if (targets.length === 0) {
    console.log('status="pending" の予約がconfig.jsonにありません。処理を終了します。');
    return;
  }

  console.log(`テスト対象: ${targets.length}件（日付条件を無視して全件処理します）`);

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 200 : 0 });
  const page = await browser.newPage();

  try {
    await login(page, config.loginId, config.loginPassword);
    console.log('ログイン成功');
  } catch (e) {
    console.error('ログインに失敗したため、処理を中止します:', e.message);
    logError(`[テスト実行] ログイン失敗: ${e.message}`);
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
      logError(`[テスト実行] REF#${reservation.refNumber} 予約失敗: ${e.message}\n${e.stack || ''}`);
    }
    saveConfig(config);
  }

  await browser.close();
  console.log('テスト実行が完了しました。');
}

main().catch((e) => {
  console.error('予期しないエラーが発生しました:', e);
  logError(`[テスト実行] 予期しないエラー: ${e.message}\n${e.stack || ''}`);
  process.exit(1);
});
