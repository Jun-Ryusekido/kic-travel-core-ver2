// 京都テルサ 大型バス駐車場（RESERVAプラットフォーム、reserva.be/kyototerrsaparking）の操作ロジック。
// 実際にログインして各画面のHTML構造を確認済み（2026年7月時点）。
//
//   - ログイン画面(id-sso.reserva.be/login/consumer)はCloudflareのボット対策(Turnstile)があり、
//     headless:trueだと"Just a moment..."の検証ページで止まってしまうことを確認済み。
//     このモジュールを使うスクリプトは必ずheadless:falseで実行すること。
//   - ログインフォーム: #mem_id（メールアドレス） / #mem_pass（パスワード） /
//     input[type=submit][value="ログイン"]。成功するとURLが https://reserva.be/mypage になる。
//   - 予約ページ(https://reserva.be/kyototerrsaparking)の「大型バス　夜間駐車」タイル
//     （href に "mode=service_staff" を含むリンク）をクリックすると日程選択画面に遷移する。
//   - 日程選択(カレンダー): <input type="radio" name="userselect_date" id="YYYY-MM-DD"
//     data-targetdate="YYYY-MM-DD"><label for="YYYY-MM-DD">。予約不可日は class="is-unavailable" disabled。
//     月移動はページ遷移ではなくAjax（.cal__title__arrow[data-mode=prev/next] をクリックすると
//     .cal__title__label（"YYYY年MM月"）と各セルが書き換わる）。
//   - 日付選択後、時間枠 <input type="checkbox" name="userselect_datetime" id="{date}-{sub_no}">
//     が表示される（本駐車場は「18時～翌朝8時 泊り」の1枠のみ）。ラベルのテキストで特定する。
//   - 時間枠選択後 #js-userselect-next（決定）→ a.js-userselect-submit（予約を進める）で入力画面へ。
//   - 入力画面の「利用団体」「バス会社名」等はRESERVA側のアンケート機能で自動生成される
//     id="inputItemQuesNNNNNN"（担当者ごとに変わりうる不安定なid）のため、
//     <dt>のラベルテキストから辿って対応する<input>を取得する方式にしている。
//   - 「確認する」(#contact-btn__confirm) → 確認画面で利用規約チェックボックス(#agree_terms、
//     「利用規約、RESERVA利用規約に同意する」の1つのチェックボックスで両方を兼ねている実装だった)
//     にチェック → 「完了する」(#contact-btn__rsv) で確定する。

const fs = require('fs');
const path = require('path');
const { dateForFilename } = require('./date-utils');

const LOGIN_URL = 'https://id-sso.reserva.be/login/consumer';
const RESERVE_TOP_URL = 'https://reserva.be/kyototerrsaparking';
const LOGS_DIR = path.join(__dirname, '..', 'logs');

function logError(message) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, `kyoto-terrsa-error-${dateForFilename()}.log`);
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

async function screenshotStep(page, refLabel, stepName) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const p = path.join(LOGS_DIR, `kyoto-terrsa-${refLabel}-${stepName}-${dateForFilename()}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => null);
  return p;
}

async function login(page, loginId, loginPassword) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // CloudflareのTurnstile検証が終わるまで少し待つ（headless:falseなら自動的に通過する）
  await page.waitForTimeout(3000);
  await page.fill('#mem_id', loginId);
  await page.fill('#mem_pass', loginPassword);
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null),
    page.click('input[type=submit][value="ログイン"]'),
  ]);
  await page.waitForTimeout(1500);
  if (!/\/mypage/.test(page.url())) {
    throw new Error('ログインに失敗しました（マイページに遷移しませんでした。.envのKYOTO_TERRSA_LOGIN_ID/KYOTO_TERRSA_PASSWORDをご確認ください）');
  }
}

async function openReservationFlow(page) {
  await page.goto(RESERVE_TOP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  const link = page.locator('a[href*="mode=service_staff"]').first();
  if ((await link.count()) === 0) {
    throw new Error('予約する対象（大型バス　夜間駐車）のリンクが見つかりませんでした');
  }
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null),
    link.click(),
  ]);
  await page.waitForTimeout(1500);
}

// カレンダーの対象年月まで、Ajaxの「次へ／前へ」リンクを使って移動する。
async function goToMonth(page, targetYear, targetMonth) {
  const targetLabel = `${targetYear}年${String(targetMonth).padStart(2, '0')}月`;
  let guard = 0;
  while (guard < 36) {
    const title = (await page.textContent('.cal__title__label').catch(() => '') || '').trim();
    if (title === targetLabel) return;

    const m = title.match(/(\d+)年(\d+)月/);
    if (!m) throw new Error(`カレンダーの年月表示を読み取れませんでした: "${title}"`);
    const cur = Number(m[1]) * 12 + Number(m[2]);
    const target = targetYear * 12 + targetMonth;
    const navMode = cur < target ? 'next' : 'prev';
    const navLink = page.locator(`.cal__title__arrow[data-mode="${navMode}"]`);
    if ((await navLink.count()) === 0) throw new Error('カレンダーの月移動リンクが見つかりませんでした');

    await navLink.click();
    await page.waitForTimeout(800); // Ajaxでの書き換えのため少し待つ
    guard++;
  }
  throw new Error(`カレンダーを対象年月(${targetLabel})まで移動できませんでした`);
}

// id属性が数字始まり("2026-08-14"等)だとCSSのid セレクタ(#...)としては不正になるため、
// 属性セレクタ([id="..."])で取得する。
async function isDateAvailable(page, dateISO) {
  const radio = page.locator(`input[name="userselect_date"][id="${dateISO}"]`);
  if ((await radio.count()) === 0) return false;
  return !(await radio.first().isDisabled());
}

async function selectDate(page, dateISO) {
  const [y, m] = dateISO.split('-').map(Number);
  await goToMonth(page, y, m);
  const available = await isDateAvailable(page, dateISO);
  if (!available) {
    throw new Error(`対象日(${dateISO})は選択できません（予約受付前、満車、または対象外の日付です）`);
  }
  await page.click(`label[for="${dateISO}"]`);
  await page.waitForTimeout(1000);
}

async function selectOvernightSlot(page) {
  const label = page.locator('.userselect-time label', { hasText: '18時～翌朝8時' }).first();
  try {
    await label.waitFor({ state: 'visible', timeout: 10000 });
  } catch (e) {
    throw new Error('「18時～翌朝8時泊り」の枠が見つかりませんでした（満車の可能性があります）');
  }
  await label.click();
  await page.waitForTimeout(500);
}

async function confirmDateTimeSelection(page) {
  await page.click('#js-userselect-next');
  await page.waitForTimeout(1000);
}

async function proceedToInputForm(page) {
  const submitLink = page.locator('a.js-userselect-submit');
  await submitLink.waitFor({ state: 'visible', timeout: 10000 });
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null),
    submitLink.click(),
  ]);
  await page.waitForTimeout(1500);
}

// 「利用団体」「バス会社名」等、RESERVAのアンケート項目はラベルのテキストから対応する
// <input>を辿って特定する（自動生成id(inputItemQuesNNNNNN)は不安定なため使わない）。
async function fillByQuestionLabel(page, labelText, value) {
  const dl = page.locator('dl.contact-js__item', { has: page.locator('dt', { hasText: labelText }) }).first();
  if ((await dl.count()) === 0) {
    throw new Error(`入力欄が見つかりませんでした（ラベル: ${labelText}）`);
  }
  const input = dl.locator('input[type="text"]').first();
  await input.fill(value);
}

async function fillGroupAndBusCompany(page, utilizationGroup, busCompanyName) {
  await fillByQuestionLabel(page, '利用団体', utilizationGroup);
  await fillByQuestionLabel(page, 'バス会社名', busCompanyName);
}

async function submitInputForm(page) {
  const btn = page.locator('text=確認する').first();
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null),
    btn.click(),
  ]);
  await page.waitForTimeout(1500);
}

// 確認画面で利用規約チェックボックスにチェックし、「完了する」を押して確定する。
// チェックボックスは<label for="agree_terms">が同じ要素を内包しつつ利用規約リンクも
// 含んでいる構造のため、Playwrightの通常のclick()だとクリック座標がリンク側に解釈されて
// しまい状態が変化しないことを確認した。要素自体は非表示ではないため、
// page.evaluateで直接.click()を発火させることで確実にチェックする。
async function agreeAndComplete(page) {
  const isChecked = await page.isChecked('#agree_terms').catch(() => false);
  if (!isChecked) {
    await page.evaluate(() => { document.querySelector('#agree_terms').click(); });
    await page.waitForTimeout(300);
  }
  const nowChecked = await page.isChecked('#agree_terms').catch(() => false);
  if (!nowChecked) {
    throw new Error('利用規約への同意チェックボックスをオンにできませんでした');
  }
  const completeBtn = page.locator('#contact-btn__rsv');
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null),
    completeBtn.click(),
  ]);
  await page.waitForTimeout(2000);
}

// 完了画面から確認番号らしき文字列を探す（見つからなければnull）。
async function extractConfirmationNumber(page) {
  const bodyText = (await page.textContent('body').catch(() => '') || '');
  const m = bodyText.match(/(?:予約番号|受付番号|確認番号)[\s:：]*([A-Za-z0-9-]{4,})/);
  return m ? m[1] : null;
}

async function isCompletionPage(page) {
  const bodyText = (await page.textContent('body').catch(() => '') || '');
  return /予約完了|ご予約が完了いたしました|ご予約いただき、誠にありがとうございます/.test(bodyText);
}

// 1件分の予約処理（ログイン後の状態のpageを渡すこと）。成功時は確認番号・スクリーンショットのパスを返す。
async function processKyotoTerrsaReservation(page, dateISO, utilizationGroup, busCompanyName) {
  await openReservationFlow(page);
  await selectDate(page, dateISO);
  await screenshotStep(page, dateISO, '1-date-selected');

  await selectOvernightSlot(page);
  await confirmDateTimeSelection(page);
  await screenshotStep(page, dateISO, '2-time-confirmed');

  await proceedToInputForm(page);
  await fillGroupAndBusCompany(page, utilizationGroup, busCompanyName);
  await screenshotStep(page, dateISO, '3-form-filled');

  await submitInputForm(page);
  await screenshotStep(page, dateISO, '4-review');

  await agreeAndComplete(page);
  const screenshotPath = await screenshotStep(page, dateISO, '5-complete');

  const completed = await isCompletionPage(page);
  if (!completed) {
    throw new Error('完了画面を確認できませんでした（予約が確定していない可能性があります）');
  }
  const confirmationNumber = await extractConfirmationNumber(page);
  return { confirmationNumber, screenshotPath };
}

module.exports = {
  LOGIN_URL,
  RESERVE_TOP_URL,
  LOGS_DIR,
  login,
  openReservationFlow,
  goToMonth,
  isDateAvailable,
  selectDate,
  selectOvernightSlot,
  confirmDateTimeSelection,
  proceedToInputForm,
  fillGroupAndBusCompany,
  submitInputForm,
  agreeAndComplete,
  extractConfirmationNumber,
  isCompletionPage,
  processKyotoTerrsaReservation,
  logError,
  screenshotStep,
};
