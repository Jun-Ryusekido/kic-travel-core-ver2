// 京都テルサ 大型バス駐車場：深夜0:00の新規解禁日を狙って自動的に2台分予約するスクリプト。
// Windowsタスクスケジューラから「23:57に起動」する運用を想定している（タスク名:
// KIC_KyotoTerrsaMidnight）。起動直後にensureLoggedIn()がログイン状態（永続化Chrome
// プロファイルに保存されたセッション）を確認する。ログイン済みならそのまま自動で
// 解禁待ち〜予約実行まで進む。未ログインの場合はログイン画面を開くだけにとどめて
// 処理を中止する（Cloudflareのロボット確認はこの自動化セッションでは人間が手動で
// チェックしても実際にはログインが成立しないことを確認済みのため、待機はしない方針。
// ログインは別途 parking-kyoto-terrsa.js 等を手動実行して人間が完了させ、同じ
// 永続化プロファイルにセッションを保存しておく運用とする）。
//
// 実行方法:
//   node parking-kyoto-terrsa-midnight.js
//   node parking-kyoto-terrsa-midnight.js --date 2026-10-14
//   node parking-kyoto-terrsa-midnight.js --dates 2026-10-14,2026-10-15,2026-10-16
//   node parking-kyoto-terrsa-midnight.js --vehicles 1
//   node parking-kyoto-terrsa-midnight.js --dry-run
//   node parking-kyoto-terrsa-midnight.js --date 2026-10-14 --dry-run
//
// 【注意】--dry-run を付けない場合、実際に駐車場の予約枠を確定させます（既定で2台分）。
//
// --dates で複数日を優先順位付きで指定した場合（--dateは1件版のエイリアス）:
//   最初の日付だけを「本日深夜0:00に新規解禁される日」として解禁待ちリトライ（最大10分）の対象にする。
//   台数分の予約が埋まるまで、先頭の日付から順に予約を試みる。ある日付で満車等により
//   これ以上予約できなくなったら、残り台数を次の候補日で試す（2件目以降の候補日は解禁待ちをせず、
//   その時点の空き状況を1回だけ確認してすぐ予約を試みる）。すでに目標台数を確保できたら、
//   残りの候補日には進まない。
//
// 対象日の自動判定について:
//   予約受付開始はサイトの表記上「利用日の3ヶ月前の00:00から」。したがって「本日の深夜0:00
//   （＝明日0:00）」に新しく解禁される日は、理論上「明日の日付の3ヶ月後」になる
//   （例: 実行日が2026-07-13なら、明日2026-07-14の3ヶ月後＝2026-10-14）。
//   --date / --dates を指定しない場合はこの計算で自動的に対象日を決定し、念のため前後1日分
//   （前日・当日・翌日）も候補に含める（当日を最優先候補として解禁待ちリトライの対象にし、
//   前日・翌日は当日で目標台数に届かなかった場合のみ次点候補として試す）。
//   --date / --dates を明示指定した場合は、これまで通りその指定日を優先する（手動テスト用）。
//
// ログインは自動化していません。chromium.launchPersistentContext で永続化した
// Chromeプロファイル（PROFILE_DIR）を使い、人間が別途（このスクリプトの外で）手動で
// ログイン（ID/パスワード入力・Cloudflareのロボット確認含む）を済ませたセッションを
// 再利用します。未ログインの場合、このスクリプトはログイン画面を開くだけで待たずに
// 終了します（詳細は lib/kyoto-terrsa-booking-flow.js の ensureLoggedIn() を参照）。
// このサイトはCloudflareのボット対策があり、headless:trueだと検証ページで止まってしまうため
// 常にheadless:falseで実行する（下記のHEADLESSは変更しないこと）。
const HEADLESS = false;

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { getTodayJST, subtractDays, addMonths } = require('./lib/date-utils');
const {
  ensureLoggedIn,
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

// 人間が手動でログイン（Cloudflareのロボット確認含む）したセッションを保持し続ける
// 永続化Chromeプロファイル。parking-kyoto-terrsa.js（通常実行版）と同じプロファイルを
// 共有し、どちらかで一度ログインすればもう片方でも再利用できるようにする。
const PROFILE_DIR = path.join(__dirname, 'chrome-profile-kyoto-terrsa');

const UTILIZATION_GROUP = 'KIC0000';
const BUS_COMPANY_NAME = 'KICトラベル';
const RETRY_INTERVAL_MS = 2500; // 解禁待ちリトライの間隔（回線負荷を抑えるため2〜3秒程度）
const RETRY_MAX_WAIT_MS = 10 * 60 * 1000; // 解禁待ちの最大待機時間（10分。要件通り）
// 何が起きても必ずプロセスを終了させる安全装置。ログインは待たずに即エラーになるため、
// 実質的には解禁待ちリトライ最大10分＋予約処理時間が収まればよいが、余裕を見て20分に設定。
const HARD_WATCHDOG_MS = 20 * 60 * 1000;

function parseArgs(argv) {
  const args = { vehicles: 2, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date' && argv[i + 1]) { args.date = argv[i + 1]; i++; }
    else if (argv[i] === '--dates' && argv[i + 1]) { args.dates = argv[i + 1]; i++; }
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

// --date / --dates の指定がない場合の候補日リストを自動計算する。
// 自動計算した対象日を最優先候補にし、念のため前後1日分（前日・翌日）も次点候補に含める。
function autoDetectCandidateDates() {
  const target = autoDetectTargetDate();
  return [target, subtractDays(target, 1), subtractDays(target, -1)];
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
  let dates;
  let dateSource;
  if (args.dates) {
    dates = args.dates.split(',').map((s) => s.trim()).filter(Boolean);
    dateSource = '（指定）';
  } else if (args.date) {
    dates = [args.date];
    dateSource = '（指定・1件）';
  } else {
    dates = autoDetectCandidateDates();
    dateSource = '（自動計算：3ヶ月後ルール＋前後1日）';
    console.log(`本日の自動計算による対象日: ${dates[0]}（次点候補: ${dates[1]}, ${dates[2]}）`);
  }
  const totalVehicles = args.vehicles;

  for (const d of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      console.error(`対象日の形式が不正です: ${d}`);
      process.exitCode = 1;
      return;
    }
  }
  if (!Number.isInteger(totalVehicles) || totalVehicles < 1) {
    console.error('--vehicles には1以上の整数を指定してください');
    process.exitCode = 1;
    return;
  }

  console.log(`===== 京都テルサ 深夜自動予約 =====`);
  console.log(`候補日（優先順）: ${dates.join(' → ')}${dateSource} / 台数: ${totalVehicles} / dry-run: ${args.dryRun}`);

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: HEADLESS, slowMo: HEADLESS ? 200 : 0 });
  const page = context.pages()[0] || await context.newPage();
  const startedAt = Date.now();
  const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1);

  try {
    await ensureLoggedIn(page);
    console.log(`ログイン確認完了（${elapsed()}秒経過）`);
  } catch (e) {
    console.error('ログイン確認に失敗したため、処理を中止します:', e.message);
    logError(`[深夜自動実行] ログイン失敗: ${e.message}`);
    if (!args.dryRun) {
      for (const d of dates) {
        for (let v = 1; v <= totalVehicles; v++) {
          await recordResult(sb, { dateISO: d, vehicleIndex: v, totalVehicles, status: '失敗', resultMessage: `ログイン失敗: ${e.message}` });
        }
      }
    }
    writeSummaryLog([`候補日: ${dates.join(', ')}`, `結果: ログイン失敗`, `エラー: ${e.message}`]);
    await context.close();
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    console.log('--dry-run のため、カレンダーの空き状況チェックのみ行います（予約は実行しません）。');
    const lines = ['[dry-run] 候補日の空き状況'];
    try {
      for (const d of dates) {
        await openReservationFlow(page);
        const [y, m] = d.split('-').map(Number);
        await goToMonth(page, y, m);
        const available = await isDateAvailable(page, d);
        const line = `対象日(${d})は現在${available ? '選択可能です' : 'まだ選択できません'}（${elapsed()}秒経過）`;
        console.log(line);
        lines.push(`${d}: 選択可能=${available}`);
      }
      writeSummaryLog(lines);
    } catch (e) {
      console.error('チェック中にエラーが発生しました:', e.message);
      logError(`[深夜自動実行/dry-run] ${dates.join(',')}: ${e.message}`);
      await context.close();
      process.exitCode = 1;
      return;
    }
    await context.close();
    return;
  }

  const results = [];
  let vehiclesBooked = 0;

  for (let dateIdx = 0; dateIdx < dates.length && vehiclesBooked < totalVehicles; dateIdx++) {
    const dateISO = dates[dateIdx];
    const isPrimaryDate = dateIdx === 0;

    let available;
    if (isPrimaryDate) {
      console.log(`対象日(${dateISO})が選択可能になるまで${RETRY_INTERVAL_MS / 1000}秒間隔でリトライします（最大${RETRY_MAX_WAIT_MS / 60000}分）...`);
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
        available = false;
      }
    } else {
      // 2件目以降の候補日は解禁待ちをせず、その時点の空き状況を1回だけ確認する
      console.log(`次点候補日(${dateISO})の空き状況を確認します...（${elapsed()}秒経過）`);
      try {
        await openReservationFlow(page);
        const [y, m] = dateISO.split('-').map(Number);
        await goToMonth(page, y, m);
        available = await isDateAvailable(page, dateISO);
      } catch (e) {
        console.error(`候補日(${dateISO})の確認中にエラーが発生しました:`, e.message);
        available = false;
      }
    }

    if (!available) {
      const msg = isPrimaryDate
        ? `対象日(${dateISO})が制限時間内（${RETRY_MAX_WAIT_MS / 60000}分）に選択可能になりませんでした`
        : `候補日(${dateISO})は現在選択できません`;
      console.error(msg);
      logError(`[深夜自動実行] ${msg}`);
      continue; // 次の候補日へ
    }
    console.log(`対象日(${dateISO})は選択可能です（${elapsed()}秒経過）。予約処理を開始します。`);

    // この日付にまだ必要な台数分を、満車等で失敗するまで続けて予約する
    let localIndex = 0;
    while (vehiclesBooked < totalVehicles) {
      localIndex++;
      const vehicleStartedAt = Date.now();
      const vehicleElapsed = () => ((Date.now() - vehicleStartedAt) / 1000).toFixed(1);
      try {
        const result = await processKyotoTerrsaReservation(page, dateISO, UTILIZATION_GROUP, BUS_COMPANY_NAME, localIndex);
        vehiclesBooked++;
        console.log(`✓ [${vehiclesBooked}/${totalVehicles}台目・${dateISO}] 予約完了。確認番号: ${result.confirmationNumber || '(画面上に見つかりませんでした)'}（この台: ${vehicleElapsed()}秒 / 累計: ${elapsed()}秒）`);
        if (localIndex > 1) console.log(`  重複予約確認モーダル: ${result.duplicateModalHandled ? '検出して続行しました' : '表示されませんでした（想定外）'}`);
        results.push({ dateISO, vehicleIndex: localIndex, status: '完了', confirmationNumber: result.confirmationNumber, screenshotPath: result.screenshotPath, durationSec: vehicleElapsed() });
        await recordResult(sb, {
          dateISO, vehicleIndex: localIndex, totalVehicles, status: '完了',
          resultMessage: result.confirmationNumber ? `確認番号: ${result.confirmationNumber}` : '予約完了（確認番号は画面上に見つかりませんでした）',
          screenshotPath: result.screenshotPath,
        });
      } catch (e) {
        console.error(`✗ [${dateISO} ${localIndex}台目] 予約失敗: ${e.message}（この台: ${vehicleElapsed()}秒 / 累計: ${elapsed()}秒）`);
        logError(`[深夜自動実行] ${dateISO} (${localIndex}台目) 予約失敗: ${e.message}\n${e.stack || ''}`);
        fs.mkdirSync(LOGS_DIR, { recursive: true });
        const errShot = path.join(LOGS_DIR, `kyoto-terrsa-midnight-${dateISO}-v${localIndex}-error-${Date.now()}.png`);
        await page.screenshot({ path: errShot, fullPage: true }).catch(() => null);
        results.push({ dateISO, vehicleIndex: localIndex, status: '失敗', resultMessage: e.message, screenshotPath: errShot, durationSec: vehicleElapsed() });
        await recordResult(sb, { dateISO, vehicleIndex: localIndex, totalVehicles, status: '失敗', resultMessage: e.message, screenshotPath: errShot });
        break; // この日付はこれ以上予約できないとみなし、次の候補日へ
      }
    }
  }

  await context.close();

  const successCount = results.filter((r) => r.status === '完了').length;
  const summaryLines = [
    `===== 京都テルサ 深夜自動予約 結果 =====`,
    `候補日（優先順）: ${dates.join(' → ')} / 目標台数: ${totalVehicles} / 成功: ${successCount} / 失敗: ${results.length - successCount}`,
    `総実行時間（ログイン含む）: ${elapsed()}秒`,
    ...results.map((r) => `  ${r.dateISO} ${r.vehicleIndex}台目: [${r.status}] ${r.durationSec}秒 ${r.confirmationNumber ? '確認番号=' + r.confirmationNumber : r.resultMessage || ''}`),
  ];
  if (successCount < totalVehicles) {
    summaryLines.push(`※ 目標台数(${totalVehicles})に対し${successCount}台のみ確保できました。`);
  }
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
