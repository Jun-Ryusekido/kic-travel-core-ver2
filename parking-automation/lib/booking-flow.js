// 新大阪駅バス駐車場予約サイト(revn.jrbusparkingyoyaku.jp)の操作ロジック。
//
// ログイン画面・トップページ（エリア選択）・カレンダー画面の構造は、実際にサイトを
// 開いて確認済み（2026年7月時点）。以下のセレクタはその実際のHTMLに基づく：
//   - ログインID: #auth-login-login-id (name="login_id")
//   - パスワード: #auth-login-password (name="password")
//   - エリア選択: <fieldset><legend>エリアから選ぶ</legend> 内の <label> をラベル文字列で特定
//   - カレンダーの予約可能な枠: div.calender_list.js_can_reserve[data-usage-timestamp="YYYY/MM/DD HH:MM"]
//   - カレンダーは "?date=YYYY/MM/DD" パラメータで直接対象日へ遷移できることを確認済み
//
// 一方、ログイン後にのみ表示される「予約登録フォーム」（車両ナンバー・備考欄・
// 内容確認へ進む・支払い方法・予約を登録する、のあたり）は、ログイン認証が必要なため
// 実際の画面を確認できていない。JUNさんから伝えられた画面上の文言（ボタン名等）を
// そのまま使い、Playwrightのテキスト一致セレクタ（多少のマークアップ変更に強い）で
// 探すようにしている。もし要素が見つからない場合は、原因を明示したエラーで
// 即座に失敗させる（誤った欄に入力する事故を防ぐため）。実際にログインしての
// 動作確認時に、ここのセレクタが合っているか必ず確認すること。

const fs = require('fs');
const path = require('path');
const { toSiteDateFormat, toSiteTimestampFormat, timestampForFilename, dateForFilename } = require('./date-utils');

const BASE_URL = 'https://revn.jrbusparkingyoyaku.jp';
const LOGS_DIR = path.join(__dirname, '..', 'logs');

function logError(message) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, `error-${dateForFilename()}.log`);
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

async function login(page, loginId, loginPassword) {
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'networkidle' });
  await page.fill('#auth-login-login-id', loginId);
  await page.fill('#auth-login-password', loginPassword);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => null),
    page.click('button:has-text("ログイン")'),
  ]);
  if (page.url().includes('/auth/login')) {
    throw new Error('ログインに失敗しました（ログインページに留まっています。config.jsonのloginId/loginPasswordをご確認ください）');
  }
}

async function selectAreaAndOpenCalendar(page, facilityArea) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  const areaLabel = page.locator('fieldset', { hasText: 'エリアから選ぶ' }).locator('label', { hasText: facilityArea });
  if ((await areaLabel.count()) === 0) {
    throw new Error(`エリア「${facilityArea}」がトップページに見つかりませんでした`);
  }
  await areaLabel.first().click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => null),
    page.click('button:has-text("予約状況を見る")'),
  ]);
}

// カレンダーの対象日付へ移動する。まず ?date=YYYY/MM/DD を付与した直接遷移を試し
// （実際に有効なことを確認済み）、それでも対象日が表示されない場合のフォールバックとして
// 「次へ」ボタン(.btn-calender.is-next)を対象日になるまでクリックし続ける。
async function goToDate(page, targetDateSite) {
  const url = new URL(page.url());
  url.searchParams.set('date', targetDateSite);
  await page.goto(url.toString(), { waitUntil: 'networkidle' });

  let guard = 0;
  while (guard < 60) {
    const currentDateBtn = await page.$('.current-day.js_date_select');
    const currentVal = currentDateBtn ? await currentDateBtn.getAttribute('value') : null;
    if (currentVal === targetDateSite) return;
    const nextBtn = await page.$('#next.btn-calender.is-next');
    if (!nextBtn) break;
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null),
      nextBtn.click(),
    ]);
    guard++;
  }
  throw new Error(`カレンダーを対象日(${targetDateSite})まで移動できませんでした`);
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// 対象の開始時刻に完全一致する空き枠を探す。無ければ同じ日付の空き枠の中から
// 最も近い時刻のものを返す（該当日に空き枠が1つもなければ null）。
async function findSlot(page, targetTimestamp) {
  const exact = await page.$(`div.calender_list.js_can_reserve[data-usage-timestamp="${targetTimestamp}"]`);
  if (exact) return exact;

  const targetDate = targetTimestamp.split(' ')[0];
  const targetMinutes = timeToMinutes(targetTimestamp.split(' ')[1]);
  const candidates = await page.$$(`div.calender_list.js_can_reserve[data-usage-timestamp^="${targetDate}"]`);
  if (candidates.length === 0) return null;

  let best = null;
  let bestDiff = Infinity;
  for (const c of candidates) {
    const ts = await c.getAttribute('data-usage-timestamp');
    const diff = Math.abs(timeToMinutes(ts.split(' ')[1]) - targetMinutes);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best;
}

async function fillByLabel(page, labelPattern, value) {
  const label = page.locator('label').filter({ hasText: labelPattern }).first();
  if ((await label.count()) === 0) {
    throw new Error(`入力欄が見つかりませんでした（ラベル: ${labelPattern}）`);
  }
  const forAttr = await label.getAttribute('for');
  if (forAttr) {
    await page.fill(`#${forAttr}`, value);
    return;
  }
  const input = label.locator('xpath=following::input[1] | following::textarea[1]').first();
  await input.fill(value);
}

async function clickByText(page, text) {
  const el = page.getByText(text, { exact: false }).first();
  if ((await el.count()) === 0) {
    throw new Error(`ボタン/選択肢が見つかりませんでした（テキスト: ${text}）`);
  }
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null),
    el.click(),
  ]);
}

async function fillReservationForm(page, reservation) {
  await fillByLabel(page, /車両ナンバー|車番/, reservation.carNumber);
  await fillByLabel(page, /備考/, reservation.remarks);
  await clickByText(page, '内容確認へ進む');
  await clickByText(page, reservation.paymentMethod);
  await clickByText(page, '予約を登録する');
}

// 1件分の予約処理（ログイン後の状態のpageを渡すこと）。成功時はスクリーンショットのパスを返す。
async function processReservation(page, reservation) {
  const targetDateSite = toSiteDateFormat(reservation.startDateTime);
  const targetTimestamp = toSiteTimestampFormat(reservation.startDateTime);

  await selectAreaAndOpenCalendar(page, reservation.facilityArea);
  await goToDate(page, targetDateSite);

  const slot = await findSlot(page, targetTimestamp);
  if (!slot) {
    throw new Error(`予約可能な枠が見つかりませんでした（${targetTimestamp} 付近、当該日に空き枠なし）`);
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => null),
    slot.click(),
  ]);

  await fillReservationForm(page, reservation);

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const screenshotPath = path.join(LOGS_DIR, `reservation-${reservation.refNumber}-${timestampForFilename()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  return { screenshotPath };
}

module.exports = { login, selectAreaAndOpenCalendar, goToDate, findSlot, processReservation, logError, LOGS_DIR, BASE_URL };
