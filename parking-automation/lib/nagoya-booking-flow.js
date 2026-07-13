// 名古屋市 大型車両夜間宿泊予約システム(midori.ccx.mobi/Parking)の操作ロジック。
// 実際にログインして各画面のHTML構造を確認済み（2026年7月時点）。
//
//   - ログイン: #loginid (name="loginid") / #passwd (name="passwd") / #btnLogin。
//     成功するとURLが https://midori.ccx.mobi/Parking/Menu (マイページ)になる。
//   - マイページ→新規予約: #btnRsvAdd
//   - 駐車場選択画面(ParkMenu): ラジオボタンに<label>は無く、テーブル行(tr)の中に
//     radioとparking名がtdとして並んでいるだけ。実際に確認した対応関係は固定：
//       #rd1 (value=1) = 若宮大通公園 白川前駐車場
//       #rd2 (value=5) = 名城公園　正門前駐車場
//     選択後 #btnNext で次へ。
//   - カレンダー画面(DaySelect): 月移動はページ遷移ではなくAjax
//     （$("#lnkNavNext")/$("#lnkNavPrev") クリックで /Parking/DaySelect?Next 等を叩き、
//     #caltitle（"YYYY年M月"）と各セルを書き換える）。日付セルは
//     <td id="calcel_N" class="clickable"><span id="YYYYMMDD">日</span><br>記号</td>
//     という構造で、class="clickable"が付いている日のみ予約可能
//     （記号は ○=空き、△=一部空き、Ｘ=満車、－=対象外/未提供）。
//     駐車場選択に戻るボタンは #btnMenu。
//   - 入力フォーム(RsvNew): 1画面で最大3台分（サフィックス_1,_2,_3）を同時入力できる。
//     各台: intime_N(入庫予定時刻select) / carkind_N(車種select) / compbus_N(バス会社名) /
//     hotelname_N(運転手宿泊ホテル名) / reservename_N(申込者名・かな/カナ) /
//     outtime_N(出庫予定時刻select) / drivername_N(運転手名) /
//     drivertel_N(連絡先電話番号・数字のみ) / corno_N(車両番号・4桁数字)。
//     #btnReserve（確認・承認へ）をクリックすると検証Ajaxが走り、成功時のみ
//     /Parking/RsvAgree へ遷移する。失敗時は同じページに留まり#myMessageにエラー表示。
//   - 確認画面(RsvAgree): #btnComplete（予約確定へ）をクリックすると確定Ajaxが走り、
//     成功時は#myModalに「ご予約ありがとうございました」が表示される。
//     モーダルのOKボタン（.modal-footer .btn-primary）をクリックすると
//     /Parking/RsvComplete（完了画面）へ遷移する。

const fs = require('fs');
const path = require('path');
const { dateForFilename } = require('./date-utils');

const BASE_URL = 'https://midori.ccx.mobi/Parking';
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const MAX_VEHICLES_PER_DATE = 3; // サイト側の1画面あたりの最大入力台数

const FACILITY_DEFS = [
  { key: 'meijo', radioId: '#rd2', names: ['名城公園　正門前駐車場', '名城公園正門前駐車場', '名城公園'] },
  { key: 'wakamiya', radioId: '#rd1', names: ['若宮大通公園 白川前駐車場', '若宮大通公園　白川前駐車場', '若宮大通公園白川前駐車場', '若宮大通公園'] },
];

function logError(message) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, `nagoya-error-${dateForFilename()}.log`);
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

function normalizeFacilityName(s) {
  return (s || '').replace(/[\s　]+/g, '');
}

function resolveFacility(name) {
  const norm = normalizeFacilityName(name);
  const def = FACILITY_DEFS.find((d) => d.names.some((n) => normalizeFacilityName(n) === norm) || normalizeFacilityName(d.key) === norm);
  if (!def) throw new Error(`駐車場名を認識できませんでした: ${name}`);
  return def;
}

async function login(page, loginId, loginPassword) {
  await page.goto(`${BASE_URL}#no-back`, { waitUntil: 'networkidle' });
  await page.fill('#loginid', loginId);
  await page.fill('#passwd', loginPassword);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null),
    page.click('#btnLogin'),
  ]);
  if (!/\/Parking\/Menu/.test(page.url())) {
    throw new Error('ログインに失敗しました（マイページに遷移しませんでした。nagoya-config.jsonのloginId/loginPasswordをご確認ください）');
  }
}

async function openNewReservation(page) {
  // マイページ以外（前回処理の途中画面等）にいる場合に備え、まずマイページへ戻ってから開始する
  if (!/\/Parking\/Menu/.test(page.url())) {
    await page.goto(`${BASE_URL}/Menu`, { waitUntil: 'networkidle' });
  }
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null),
    page.click('#btnRsvAdd'),
  ]);
}

async function selectFacilityAndOpenCalendar(page, facilityName) {
  const def = resolveFacility(facilityName);
  await page.check(def.radioId);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null),
    page.click('#btnNext'),
  ]);
}

async function backToFacilitySelect(page) {
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null),
    page.click('#btnMenu'),
  ]);
}

// カレンダーの対象年月まで、Ajaxの「次へ／前へ」リンクを使って移動する。
async function goToMonth(page, targetYear, targetMonth) {
  const targetLabel = `${targetYear}年${targetMonth}月`;
  let guard = 0;
  while (guard < 36) {
    const title = (await page.textContent('#caltitle').catch(() => '') || '').trim();
    if (title === targetLabel) return;

    const m = title.match(/(\d+)年(\d+)月/);
    if (!m) throw new Error(`カレンダーの年月表示を読み取れませんでした: "${title}"`);
    const cur = Number(m[1]) * 12 + Number(m[2]);
    const target = targetYear * 12 + targetMonth;
    const navId = cur < target ? '#lnkNavNext' : '#lnkNavPrev';
    const navLi = await page.$(navId);
    if (!navLi) throw new Error('カレンダーの月移動リンクが見つかりませんでした');
    const disabled = await navLi.evaluate((el) => el.classList.contains('disabled'));
    if (disabled) throw new Error(`カレンダーを対象年月(${targetLabel})まで移動できませんでした（これ以上移動できません）`);

    await page.click(`${navId} a`);
    await page.waitForTimeout(600); // Ajaxでの書き換えのため少し待つ
    guard++;
  }
  throw new Error(`カレンダーを対象年月(${targetLabel})まで移動できませんでした`);
}

// 指定日(YYYYMMDD)のセルの状態を返す。存在しない場合はnull。
async function getDateCellStatus(page, dateCompact) {
  const span = await page.$(`[id="${dateCompact}"]`);
  if (!span) return null;
  const td = await span.evaluateHandle((el) => el.closest('td'));
  const clickable = await td.evaluate((el) => el.classList.contains('clickable'));
  const text = (await td.evaluate((el) => el.textContent || '')).trim();
  const symbol = text.replace(/^\d+/, '').trim();
  return { clickable, symbol };
}

async function clickDate(page, dateCompact) {
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null),
    page.click(`[id="${dateCompact}"]`),
  ]);
}

function stripNonDigits(s) {
  return (s || '').replace(/[^0-9]/g, '');
}

async function fillVehicleSlot(page, slotIndex, vehicle) {
  await page.selectOption(`#intime_${slotIndex}`, vehicle.inTime);
  await page.selectOption(`#carkind_${slotIndex}`, vehicle.vehicleType);
  await page.fill(`#compbus_${slotIndex}`, vehicle.busCompanyName || '');
  await page.fill(`#hotelname_${slotIndex}`, vehicle.driverHotelName || '');
  await page.fill(`#reservename_${slotIndex}`, vehicle.applicantName || '');
  await page.selectOption(`#outtime_${slotIndex}`, vehicle.outTime);
  await page.fill(`#drivername_${slotIndex}`, vehicle.driverName || '');
  await page.fill(`#drivertel_${slotIndex}`, stripNonDigits(vehicle.contactPhone));
  await page.fill(`#corno_${slotIndex}`, stripNonDigits(vehicle.carNumber));
}

// フォームに台数分入力し、「確認・承認へ」を押す。成功時はRsvAgreeへ遷移する。
async function submitReservationForm(page, vehicles) {
  if (vehicles.length > MAX_VEHICLES_PER_DATE) {
    throw new Error(`このサイトは1日あたり最大${MAX_VEHICLES_PER_DATE}台までしか同時入力できません（指定: ${vehicles.length}台）`);
  }
  for (let i = 0; i < vehicles.length; i++) {
    await fillVehicleSlot(page, i + 1, vehicles[i]);
  }
  await page.click('#btnReserve');
  try {
    await page.waitForURL('**/RsvAgree', { timeout: 15000 });
  } catch (e) {
    const msgText = (await page.textContent('#myMessage').catch(() => '') || '').trim();
    throw new Error(`確認・承認への進行に失敗しました: ${msgText || '理由不明（画面が遷移しませんでした）'}`);
  }
}

// 確認画面で「予約確定へ」を押し、完了モーダルのOKまでクリックする。
async function completeReservation(page) {
  await page.click('#btnComplete');
  await page.waitForTimeout(1000);
  const modalBody = (await page.textContent('#myModal .modal-body').catch(() => '') || '').trim();
  if (!/ありがとうございました/.test(modalBody)) {
    throw new Error(`予約確定に失敗しました: ${modalBody || '理由不明'}`);
  }
  await Promise.all([
    page.waitForURL('**/RsvComplete', { timeout: 20000 }).catch(() => null),
    page.click('#myModal .modal-footer .btn-primary'),
  ]);
}

// 1日分（複数台まとめて）の予約処理。成功時はスクリーンショットのパスを返す。
// primaryFacility が満車/予約不可の場合、fallbackFacility が指定されていれば自動的に切り替える。
async function processNagoyaDateReservation(page, targetDateISO, vehicles, primaryFacility, fallbackFacility) {
  const dateCompact = targetDateISO.replace(/-/g, '');
  const [year, month] = targetDateISO.split('-').map(Number);

  await openNewReservation(page);
  await selectFacilityAndOpenCalendar(page, primaryFacility);
  await goToMonth(page, year, month);

  let facilityUsed = primaryFacility;
  let status = await getDateCellStatus(page, dateCompact);
  if (!status) throw new Error(`カレンダー上に対象日(${targetDateISO})が見つかりませんでした`);

  if ((!status.clickable || status.symbol === 'Ｘ') && fallbackFacility) {
    await backToFacilitySelect(page);
    await selectFacilityAndOpenCalendar(page, fallbackFacility);
    await goToMonth(page, year, month);
    facilityUsed = fallbackFacility;
    status = await getDateCellStatus(page, dateCompact);
    if (!status) throw new Error(`カレンダー上に対象日(${targetDateISO})が見つかりませんでした（${fallbackFacility}）`);
  }

  if (!status.clickable || status.symbol === 'Ｘ') {
    throw new Error(`対象日(${targetDateISO})は予約できません（${facilityUsed}、状態: ${status.symbol || '不明'}）`);
  }

  await clickDate(page, dateCompact);
  await submitReservationForm(page, vehicles);
  await completeReservation(page);

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const screenshotPath = path.join(LOGS_DIR, `nagoya-${targetDateISO}-${dateForFilename()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  return { screenshotPath, facilityUsed };
}

module.exports = {
  BASE_URL,
  LOGS_DIR,
  MAX_VEHICLES_PER_DATE,
  resolveFacility,
  login,
  openNewReservation,
  selectFacilityAndOpenCalendar,
  backToFacilitySelect,
  goToMonth,
  getDateCellStatus,
  clickDate,
  submitReservationForm,
  completeReservation,
  processNagoyaDateReservation,
  logError,
};
