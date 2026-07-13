// 京都テルサ 大型バス駐車場（reserva.be/kyototerrsaparking）の自動予約スクリプト。
//
// 実行方法:
//   node parking-kyoto-terrsa.js --date 2026-10-14
//
// 【注意】このスクリプトを実行すると実際に駐車場の予約枠を1件確定させます。
//
// ログイン情報は .env の KYOTO_TERRSA_LOGIN_ID / KYOTO_TERRSA_PASSWORD から読み込みます
// （.env はgit管理外。.env.example を参考に自分で作成してください）。
// 予約サイトはCloudflareのボット対策があり、headless:trueだと検証ページで止まってしまうため
// 必ずheadless:falseで実行してください（下記のHEADLESSは変更しないこと）。
const HEADLESS = false;

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { getTodayJST, subtractMonths } = require('./lib/date-utils');
const { login, processKyotoTerrsaReservation, logError, LOGS_DIR } = require('./lib/kyoto-terrsa-booking-flow');

const SUPABASE_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

const BOOKING_WINDOW_MONTHS = 3; // 予約受付開始：利用日の3ヶ月前の00:00から
const UTILIZATION_GROUP = 'KIC0000';
const BUS_COMPANY_NAME = 'KICトラベル';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date' && argv[i + 1]) {
      args.date = argv[i + 1];
      i++;
    }
  }
  return args;
}

function nextDateISO(dateISO) {
  const d = new Date(dateISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function recordResult(sb, { dateISO, status, resultMessage, screenshotPath }) {
  const payload = {
    facility_type: 'kyoto_terrsa',
    ref_no: `KYOTO-${dateISO}`,
    facility_area: '京都テルサ大型バス駐車場',
    start_datetime: `${dateISO}T18:00:00`,
    end_datetime: `${nextDateISO(dateISO)}T08:00:00`,
    status,
    result_message: resultMessage || null,
    screenshot_path: screenshotPath || null,
    extra: { utilization_group: UTILIZATION_GROUP, bus_company_name: BUS_COMPANY_NAME },
  };
  const { error } = await sb.from('parking_reservations').insert(payload);
  if (error) {
    console.error('Supabaseへの結果記録に失敗しました:', error.message);
    logError(`[記録失敗] ${dateISO}: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error('使い方: node parking-kyoto-terrsa.js --date YYYY-MM-DD');
    process.exit(1);
  }
  const dateISO = args.date;

  const loginId = process.env.KYOTO_TERRSA_LOGIN_ID;
  const password = process.env.KYOTO_TERRSA_PASSWORD;
  if (!loginId || !password) {
    console.error('.envにKYOTO_TERRSA_LOGIN_ID / KYOTO_TERRSA_PASSWORDを設定してください（.env.exampleを参照）。');
    process.exit(1);
  }

  // 予約受付開始（3ヶ月前の00:00）のチェック
  const today = getTodayJST();
  const openDate = subtractMonths(dateISO, BOOKING_WINDOW_MONTHS);
  if (today < openDate) {
    console.error(`対象日(${dateISO})はまだ予約受付開始前です（受付開始日: ${openDate}）。処理を終了します。`);
    process.exit(1);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 200 : 0 });
  const page = await browser.newPage();
  const startedAt = Date.now();

  try {
    await login(page, loginId, password);
    console.log(`ログイン成功（${((Date.now() - startedAt) / 1000).toFixed(1)}秒経過）`);
  } catch (e) {
    console.error('ログインに失敗したため、処理を中止します:', e.message);
    logError(`ログイン失敗: ${e.message}`);
    await recordResult(sb, { dateISO, status: '失敗', resultMessage: e.message });
    await browser.close();
    process.exit(1);
  }

  try {
    const result = await processKyotoTerrsaReservation(page, dateISO, UTILIZATION_GROUP, BUS_COMPANY_NAME);
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`✓ ${dateISO} 予約完了。確認番号: ${result.confirmationNumber || '(画面上に見つかりませんでした)'}`);
    console.log(`  スクリーンショット: ${result.screenshotPath}`);
    console.log(`  実行時間（ログイン開始〜完了確認まで）: ${elapsedSec}秒`);
    await recordResult(sb, {
      dateISO,
      status: '完了',
      resultMessage: result.confirmationNumber ? `確認番号: ${result.confirmationNumber}` : '予約完了（確認番号は画面上に見つかりませんでした）',
      screenshotPath: result.screenshotPath,
    });
  } catch (e) {
    console.error(`✗ ${dateISO} 予約失敗: ${e.message}`);
    logError(`${dateISO} 予約失敗: ${e.message}\n${e.stack || ''}`);
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const errShot = path.join(LOGS_DIR, `kyoto-terrsa-${dateISO}-error.png`);
    await page.screenshot({ path: errShot, fullPage: true }).catch(() => null);
    await recordResult(sb, { dateISO, status: '失敗', resultMessage: e.message, screenshotPath: errShot });
  }

  await browser.close();
}

main().catch((e) => {
  console.error('予期しないエラーが発生しました:', e);
  logError(`予期しないエラー: ${e.message}\n${e.stack || ''}`);
  process.exit(1);
});
