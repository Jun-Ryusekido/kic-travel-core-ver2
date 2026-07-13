// 京都テルサ 大型バス駐車場：深夜0:00の新規解禁日を狙って自動的に2台分予約するスクリプト。
// Windowsタスクスケジューラから「23:59台に起動」するような使い方を想定している。
//
// 実行方法:
//   node parking-kyoto-terrsa-midnight.js
//   node parking-kyoto-terrsa-midnight.js --date 2026-10-14
//   node parking-kyoto-terrsa-midnight.js --vehicles 1
//   node parking-kyoto-terrsa-midnight.js --dry-run
//   node parking-kyoto-terrsa-midnight.js --date 2026-10-14 --dry-run
//
// 【注意】--dry-run を付けない場合、実際に駐車場の予約枠を確定させます（既定で2台分）。
//
// 対象日の自動判定について:
//   予約受付開始はサイトの表記上「利用日の3ヶ月前の00:00から」。したがって「本日の深夜0:00
//   （＝明日0:00）」に新しく解禁される日は、理論上「明日の日付の3ヶ月後」になる
//   （例: 実行日が2026-07-13なら、明日2026-07-14の3ヶ月後＝2026-10-14）。
//   --date を指定しない場合はこの計算で自動的に対象日を決定する。
//   ただし実際のカレンダーの解禁挙動は運用上この通りとは限らないため、--dateで明示指定する方が確実。
//
// ログイン情報は .env の KYOTO_TERRSA_LOGIN_ID / KYOTO_TERRSA_PASSWORD から読み込む。
// このサイトはCloudflareのボット対策(Turnstile)がありheadless:trueだと動作しないため、
// 常にheadless:falseで実行する（下記のHEADLESSは変更しないこと）。
const HEADLESS = false;

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { getTodayJST, subtractDays, addMonths } = require('./lib/date-utils');
const {
  login,
  openReservationFlow,
  goToMonth,
  isDateAvailable,
  processKyotoTerrsaReservation,
  waitForDateAvailable,
  logError,
  LOGS_DIR,
} = require('./lib/kyoto-terrsa-booking-flow');

const SUPABASE_URL = 'https://nzdygjlnzvtdezslnuoy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Cnloaxzb2Ati8gmCa-1o3Q_t3uy6_mB';

const UTILIZATION_GROUP = 'KIC0000';
const BUS_COMPANY_NAME = 'KICトラベル';
const RETRY_INTERVAL_MS = 2500; // 解禁待ちリトライの間隔（回線負荷を抑えるため2〜3秒程度）
const RETRY_MAX_WAIT_MS = 10 * 60 * 1000; // 解禁待ちの最大待機時間（10分。要件通り）
const HARD_WATCHDOG_MS = 15 * 60 * 1000; // 何が起きても必ずプロセスを終了させる安全装置（15分）

function parseArgs(argv) {
  const args = { vehicles: 2, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date' && argv[i + 1]) { args.date = argv[i + 1]; i++; }
    else if (argv[i] === '--vehicles' && argv[i + 1]) { args.vehicles = Number(argv[i + 1]); i++; }
    else if (argv[i] === '--dry-run') { args.dryRun = true; }
  }
  return args;
}

// 実行日の翌日から3ヶ月後の日付を「本日深夜0:00に新規解禁される日」として自動算出する。
function autoDetectTargetDate() {
  const today = getTodayJST();
  const tomorrow = subtractDays(today, -1);
  return addMonths(tomorrow, 3);
}

function nextDateISO(dateISO) {
  const d = new Date(dateISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function writeSummaryLog(lines) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const p = path.join(LOGS_DIR, `kyoto-terrsa-midnight-summary-${Date.now()}.log`);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
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
      source: 'midnight-auto-retry',
    },
  };
  try {
    const { error } = await sb.from('parking_reservations').insert(payload);
    if (error) {
      console.error('Supabaseへの結果記録に失敗しました:', error.message);
      logError(`[深夜自動実行/記録失敗] ${dateISO} (${vehicleIndex}/${totalVehicles}): ${error.message}`);
    }
  } catch (e) {
    console.error('Supabaseへの結果記録中に例外が発生しました:', e.message);
    logError(`[深夜自動実行/記録例外] ${dateISO} (${vehicleIndex}/${totalVehicles}): ${e.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dateISO = args.date || autoDetectTargetDate();
  const totalVehicles = args.vehicles;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    console.error(`対象日の形式が不正です: ${dateISO}`);
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(totalVehicles) || totalVehicles < 1) {
    console.error('--vehicles には1以上の整数を指定してください');
    process.exitCode = 1;
    return;
  }

  console.log(`===== 京都テルサ 深夜自動予約 =====`);
  console.log(`対象日: ${dateISO}${args.date ? '（指定）' : '（自動判定：明日の3ヶ月後）'} / 台数: ${totalVehicles} / dry-run: ${args.dryRun}`);

  const loginId = process.env.KYOTO_TERRSA_LOGIN_ID;
  const password = process.env.KYOTO_TERRSA_PASSWORD;
  if (!loginId || !password) {
    console.error('.envにKYOTO_TERRSA_LOGIN_ID / KYOTO_TERRSA_PASSWORDを設定してください（.env.exampleを参照）。');
    process.exitCode = 1;
    return;
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
    logError(`[深夜自動実行] ログイン失敗: ${e.message}`);
    if (!args.dryRun) {
      for (let v = 1; v <= totalVehicles; v++) {
        await recordResult(sb, { dateISO, vehicleIndex: v, totalVehicles, status: '失敗', resultMessage: `ログイン失敗: ${e.message}` });
      }
    }
    writeSummaryLog([`対象日: ${dateISO}`, `結果: ログイン失敗`, `エラー: ${e.message}`]);
    await browser.close();
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    console.log('--dry-run のため、カレンダーの空き状況チェックのみ行います（予約は実行しません）。');
    try {
      await openReservationFlow(page);
      const [y, m] = dateISO.split('-').map(Number);
      await goToMonth(page, y, m);
      const available = await isDateAvailable(page, dateISO);
      console.log(`対象日(${dateISO})は現在${available ? '選択可能です' : 'まだ選択できません'}（${elapsed()}秒経過）`);
      writeSummaryLog([`[dry-run] 対象日: ${dateISO}`, `選択可能: ${available}`]);
    } catch (e) {
      console.error('チェック中にエラーが発生しました:', e.message);
      logError(`[深夜自動実行/dry-run] ${dateISO}: ${e.message}`);
      await browser.close();
      process.exitCode = 1;
      return;
    }
    await browser.close();
    return;
  }

  console.log(`対象日(${dateISO})が選択可能になるまで${RETRY_INTERVAL_MS / 1000}秒間隔でリトライします（最大${RETRY_MAX_WAIT_MS / 60000}分）...`);
  let available = false;
  try {
    available = await waitForDateAvailable(page, dateISO, {
      intervalMs: RETRY_INTERVAL_MS,
      maxWaitMs: RETRY_MAX_WAIT_MS,
      onTick: ({ attempt, available, elapsedMs }) => {
        console.log(`  [試行${attempt}] ${(elapsedMs / 1000).toFixed(1)}秒経過 - ${available ? '選択可能になりました' : 'まだ選択できません'}`);
      },
    });
  } catch (e) {
    console.error('解禁待ちリトライ中にエラーが発生しました:', e.message);
    logError(`[深夜自動実行] リトライ中エラー: ${e.message}`);
  }

  if (!available) {
    const msg = `対象日(${dateISO})が制限時間内（${RETRY_MAX_WAIT_MS / 60000}分）に選択可能になりませんでした`;
    console.error(msg);
    logError(`[深夜自動実行] ${msg}`);
    for (let v = 1; v <= totalVehicles; v++) {
      await recordResult(sb, { dateISO, vehicleIndex: v, totalVehicles, status: '失敗', resultMessage: msg });
    }
    writeSummaryLog([`対象日: ${dateISO}`, `結果: 解禁待ちタイムアウト`, msg]);
    await browser.close();
    process.exitCode = 1;
    return;
  }
  console.log(`対象日(${dateISO})が選択可能になりました（${elapsed()}秒経過）。予約処理を開始します。`);

  const results = [];
  for (let v = 1; v <= totalVehicles; v++) {
    try {
      const result = await processKyotoTerrsaReservation(page, dateISO, UTILIZATION_GROUP, BUS_COMPANY_NAME, totalVehicles > 1 ? v : undefined);
      console.log(`✓ [${v}/${totalVehicles}台目] 予約完了。確認番号: ${result.confirmationNumber || '(画面上に見つかりませんでした)'}（${elapsed()}秒経過）`);
      if (v > 1) console.log(`  重複予約確認モーダル: ${result.duplicateModalHandled ? '検出して続行しました' : '表示されませんでした（想定外）'}`);
      results.push({ vehicleIndex: v, status: '完了', confirmationNumber: result.confirmationNumber, screenshotPath: result.screenshotPath });
      await recordResult(sb, {
        dateISO, vehicleIndex: v, totalVehicles, status: '完了',
        resultMessage: result.confirmationNumber ? `確認番号: ${result.confirmationNumber}` : '予約完了（確認番号は画面上に見つかりませんでした）',
        screenshotPath: result.screenshotPath,
      });
    } catch (e) {
      console.error(`✗ [${v}/${totalVehicles}台目] 予約失敗: ${e.message}（${elapsed()}秒経過）`);
      logError(`[深夜自動実行] ${dateISO} (${v}/${totalVehicles}) 予約失敗: ${e.message}\n${e.stack || ''}`);
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      const errShot = path.join(LOGS_DIR, `kyoto-terrsa-midnight-${dateISO}-v${v}-error-${Date.now()}.png`);
      await page.screenshot({ path: errShot, fullPage: true }).catch(() => null);
      results.push({ vehicleIndex: v, status: '失敗', resultMessage: e.message, screenshotPath: errShot });
      await recordResult(sb, { dateISO, vehicleIndex: v, totalVehicles, status: '失敗', resultMessage: e.message, screenshotPath: errShot });
    }
  }

  await browser.close();

  const successCount = results.filter((r) => r.status === '完了').length;
  const summaryLines = [
    `===== 京都テルサ 深夜自動予約 結果 =====`,
    `対象日: ${dateISO} / 台数: ${totalVehicles} / 成功: ${successCount} / 失敗: ${totalVehicles - successCount}`,
    `総実行時間: ${elapsed()}秒`,
    ...results.map((r) => `  ${r.vehicleIndex}台目: [${r.status}] ${r.confirmationNumber ? '確認番号=' + r.confirmationNumber : r.resultMessage || ''}`),
  ];
  console.log('\n' + summaryLines.join('\n'));
  const summaryPath = writeSummaryLog(summaryLines);
  console.log(`\nサマリーを保存しました: ${summaryPath}`);

  if (successCount < totalVehicles) process.exitCode = 1;
}

// タスクスケジューラ等の無人実行で、万一ブラウザやネットワーク待ちがハングしても
// 必ずプロセスが終了するようにする安全装置（通常はmain()が先に正常終了する）。
const watchdog = setTimeout(() => {
  console.error(`安全装置: ${HARD_WATCHDOG_MS / 60000}分経過してもプロセスが終了しなかったため強制終了します。`);
  logError('[深夜自動実行] 安全装置により強制終了しました（ハング検知）');
  process.exit(1);
}, HARD_WATCHDOG_MS);
// 明示的にunrefしない（他の処理が終わっていてもこのタイマーだけでプロセスが延命し、
// 確実に安全装置として機能するようにするため）

main()
  .catch((e) => {
    console.error('予期しないエラーが発生しました:', e);
    logError(`[深夜自動実行] 予期しないエラー: ${e.message}\n${e.stack || ''}`);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(watchdog);
    process.exit(process.exitCode || 0);
  });
