// 京都テルサ 大型バス駐車場（RESERVAプラットフォーム、reserva.be/kyototerrsaparking）の操作ロジック。
// 実際にログインして各画面のHTML構造を確認済み（2026年7月時点）。ログインから予約確定まで
// すべて同一ブラウザセッション・同一page内で連続実行する（途中で再ログインやページ再読み込みは行わない）。
// 各ステップ間の待機は、固定時間のsleepではなく「次に操作する要素が実際に表示されるまで」を
// 待つ方式にしている（AJAX/ページ遷移どちらでも、要素が揃い次第すぐ次の操作に進むため速い）。
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
//     このチェックボックスはPlaywrightの通常click()だと状態が変化しないことを確認済みのため、
//     page.evaluateで直接.click()を発火させている。

const fs = require('fs');
const path = require('path');
const { dateForFilename, timestampForFilename } = require('./date-utils');

const LOGIN_URL = 'https://id-sso.reserva.be/login/consumer';
const RESERVE_TOP_URL = 'https://reserva.be/kyototerrsaparking';
const LOGS_DIR = path.join(__dirname, '..', 'logs');

function logError(message) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, `kyoto-terrsa-error-${dateForFilename()}.log`);
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

// スクリーンショット保存はawaitせず呼び出し元に返す（本流の待ち時間に含めない）。
// ファイル名にはtimestampForFilename()（秒まで含む）を使い、同一日に複数台分を連続実行しても
// ファイルが上書きされないようにしている。
function screenshotStep(page, refLabel, stepName) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const p = path.join(LOGS_DIR, `kyoto-terrsa-${refLabel}-${stepName}-${timestampForFilename()}.png`);
  const promise = page.screenshot({ path: p, fullPage: true }).catch(() => null);
  return { path: p, promise };
}

async function login(page, loginId, loginPassword) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // CloudflareのTurnstile検証を経てログインフォームが操作可能になるまで待つ
  // （固定sleepではなく、フォーム自体の出現を待つことで検証が早く終われば即座に次へ進む）
  await page.waitForSelector('#mem_id', { state: 'visible', timeout: 20000 });
  await page.fill('#mem_id', loginId);
  await page.fill('#mem_pass', loginPassword);
  await Promise.all([
    page.waitForURL(/\/mypage/, { timeout: 20000 }).catch(() => null),
    page.click('input[type=submit][value="ログイン"]'),
  ]);
  if (!/\/mypage/.test(page.url())) {
    throw new Error('ログインに失敗しました（マイページに遷移しませんでした。.envのKYOTO_TERRSA_LOGIN_ID/KYOTO_TERRSA_PASSWORDをご確認ください）');
  }
}

async function openReservationFlow(page) {
  await page.goto(RESERVE_TOP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const link = page.locator('a[href*="mode=service_staff"]').first();
  await link.waitFor({ state: 'visible', timeout: 15000 });
  await link.click();
  await page.locator('.cal__title__label').waitFor({ state: 'visible', timeout: 15000 });
}

// カレンダーの対象年月まで、Ajaxの「次へ／前へ」リンクを使って移動する。
// クリックのたびに「タイトル表示が変わるまで」を待つため、Ajax応答が速ければ即座に次へ進む。
async function goToMonth(page, targetYear, targetMonth) {
  const targetLabel = `${targetYear}年${String(targetMonth).padStart(2, '0')}月`;
  const titleLocator = page.locator('.cal__title__label');
  let guard = 0;
  while (guard < 36) {
    const title = (await titleLocator.textContent().catch(() => '') || '').trim();
    if (title === targetLabel) return;

    const m = title.match(/(\d+)年(\d+)月/);
    if (!m) throw new Error(`カレンダーの年月表示を読み取れませんでした: "${title}"`);
    const cur = Number(m[1]) * 12 + Number(m[2]);
    const target = targetYear * 12 + targetMonth;
    const navMode = cur < target ? 'next' : 'prev';
    const navLink = page.locator(`.cal__title__arrow[data-mode="${navMode}"]`);
    if ((await navLink.count()) === 0) throw new Error('カレンダーの月移動リンクが見つかりませんでした');

    await navLink.click();
    await page.waitForFunction(
      (prevTitle) => {
        const el = document.querySelector('.cal__title__label');
        return el && el.textContent.trim() !== prevTitle;
      },
      title,
      { timeout: 5000 },
    ).catch(() => null);
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
}

async function selectOvernightSlot(page) {
  const label = page.locator('.userselect-time label', { hasText: '18時～翌朝8時' }).first();
  try {
    await label.waitFor({ state: 'visible', timeout: 10000 });
  } catch (e) {
    throw new Error('「18時～翌朝8時泊り」の枠が見つかりませんでした（満車の可能性があります）');
  }
  await label.click();
}

async function confirmDateTimeSelection(page) {
  await page.click('#js-userselect-next');
  await page.locator('a.js-userselect-submit').waitFor({ state: 'visible', timeout: 10000 });
}

async function proceedToInputForm(page) {
  const submitLink = page.locator('a.js-userselect-submit');
  await submitLink.click();
  // 入力画面の最初の質問項目（利用団体）が表示されるまで待つ
  await page.locator('dl.contact-js__item', { has: page.locator('dt', { hasText: '利用団体' }) })
    .waitFor({ state: 'visible', timeout: 15000 });
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
  await btn.click();
  await page.locator('#agree_terms').waitFor({ state: 'visible', timeout: 15000 });
}

// 確認画面で利用規約チェックボックスにチェックし、「完了する」を押して確定する。
// チェックボックスは<label for="agree_terms">が同じ要素を内包しつつ利用規約リンクも
// 含んでいる構造のため、Playwrightの通常のclick()だとクリック座標がリンク側に解釈されて
// しまい状態が変化しないことを確認した。要素自体は非表示ではないため、
// page.evaluateで直接.click()を発火させることで確実にチェックする。
const COMPLETION_TEXT_RE = /予約完了|ご予約が完了いたしました|ご予約いただき、誠にありがとうございます/;

// 「完了する」クリック後の分岐を1本のポーリングで検知する。
// ・そのまま完了画面へ遷移した場合（1台目等）→ 'completed'
// ・「既に同じ日時で予約しています。さらに同じ日時に別予約を追加しますか。」モーダル
//   （<div id="modal_alert" class="modal full duplicated">、ボタンは<button>/<a>ではなく
//   <input type="button" class="continue_btn" value="予約を進める">であることを実DOMで確認済み）
//   が出た場合→ 'modal'
// のどちらが先に起きるかを短い間隔（150ms）でポーリングし、待ち時間を最小限にする
// （固定sleepではなく「状態が変わった瞬間」で即座に次の処理へ進むため速い）。
async function waitForModalOrCompletion(page, { timeoutMs = 15000, pollIntervalMs = 150 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    let state = null;
    try {
      state = await page.evaluate((completionPattern) => {
        const modalBtn = document.querySelector('#modal_alert input.continue_btn');
        const modalVisible = !!(modalBtn && modalBtn.offsetParent !== null);
        const completed = new RegExp(completionPattern).test(document.body.innerText);
        return { modalVisible, completed };
      }, COMPLETION_TEXT_RE.source);
    } catch (e) {
      // ページ遷移の途中で実行コンテキストが破棄されエラーになることがある。
      // 次のポーリングで新しいページのDOMを読み直せば済むため、ここでは無視して継続する。
    }
    if (state && state.completed) return 'completed';
    if (state && state.modalVisible) return 'modal';
    await page.waitForTimeout(pollIntervalMs);
  }
  return 'timeout';
}

// 確認画面で利用規約チェックボックスにチェックし、「完了する」を押して確定する。
// expectDuplicateModal=trueの場合（2台目以降の予約）、重複予約確認モーダルが出るのが
// 正常系のため、出なかった場合はコンソールに警告を出す（それでも処理は続行する）。
async function agreeAndComplete(page, { expectDuplicateModal = false } = {}) {
  const isChecked = await page.isChecked('#agree_terms').catch(() => false);
  if (!isChecked) {
    await page.evaluate(() => { document.querySelector('#agree_terms').click(); });
    await page.waitForFunction(() => document.querySelector('#agree_terms')?.checked === true, { timeout: 3000 }).catch(() => null);
  }
  const nowChecked = await page.isChecked('#agree_terms').catch(() => false);
  if (!nowChecked) {
    throw new Error('利用規約への同意チェックボックスをオンにできませんでした');
  }
  const completeBtn = page.locator('#contact-btn__rsv');
  await completeBtn.click();

  const outcome = await waitForModalOrCompletion(page);
  let duplicateModalHandled = false;
  if (outcome === 'modal') {
    duplicateModalHandled = await page.evaluate(() => {
      const el = document.querySelector('#modal_alert input.continue_btn');
      if (el && el.offsetParent !== null) { el.click(); return true; }
      return false;
    }).catch(() => false);
    // モーダルの「予約を進める」を押した後、実際に完了画面へ遷移するまで待つ
    await page.waitForFunction(
      (pattern) => new RegExp(pattern).test(document.body.innerText),
      COMPLETION_TEXT_RE.source,
      { timeout: 15000 },
    ).catch(() => null);
  } else if (outcome === 'timeout') {
    // どちらの状態も検知できなかった場合のみ、念のため少し長めに完了画面を待つ
    await page.waitForFunction(
      (pattern) => new RegExp(pattern).test(document.body.innerText),
      COMPLETION_TEXT_RE.source,
      { timeout: 10000 },
    ).catch(() => null);
  }

  if (expectDuplicateModal && !duplicateModalHandled) {
    console.warn('警告: 2台目以降の予約のはずですが、重複予約確認モーダル（「既に同じ日時で予約しています」）が表示されませんでした。処理は続行します。');
  } else if (!expectDuplicateModal && duplicateModalHandled) {
    console.warn('警告: 1台目の予約のはずですが、重複予約確認モーダルが表示されました（想定外）。「予約を進める」をクリックして続行しました。');
  }

  return { duplicateModalHandled };
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
// ログインから完了まで、すべて同一ページ・同一セッション内で連続実行する（再ログイン・再読み込みなし）。
// vehicleIndexはログ・スクリーンショットのファイル名の重複を避けるための識別子（省略可）。
async function processKyotoTerrsaReservation(page, dateISO, utilizationGroup, busCompanyName, vehicleIndex) {
  const label = vehicleIndex ? `${dateISO}-v${vehicleIndex}` : dateISO;
  const shots = [];

  await openReservationFlow(page);
  await selectDate(page, dateISO);
  shots.push(screenshotStep(page, label, '1-date-selected'));

  await selectOvernightSlot(page);
  await confirmDateTimeSelection(page);
  shots.push(screenshotStep(page, label, '2-time-confirmed'));

  await proceedToInputForm(page);
  await fillGroupAndBusCompany(page, utilizationGroup, busCompanyName);
  shots.push(screenshotStep(page, label, '3-form-filled'));

  await submitInputForm(page);
  shots.push(screenshotStep(page, label, '4-review'));

  // 2台目以降（vehicleIndexが2以上）は、同一日時への追加予約となるため
  // 「既に同じ日時で予約しています」の重複確認モーダルが出るのが正常系。
  const { duplicateModalHandled } = await agreeAndComplete(page, { expectDuplicateModal: vehicleIndex > 1 });
  const finalShot = screenshotStep(page, label, '5-complete');
  shots.push(finalShot);

  const completed = await isCompletionPage(page);
  if (!completed) {
    await Promise.all(shots.map((s) => s.promise));
    throw new Error('完了画面を確認できませんでした（予約が確定していない可能性があります）');
  }
  const confirmationNumber = await extractConfirmationNumber(page);
  await Promise.all(shots.map((s) => s.promise)); // 結果を返す前に保存だけは完了させる
  return { confirmationNumber, screenshotPath: finalShot.path, duplicateModalHandled };
}

// 対象日程がカレンダー上で選択可能になるまで、指定間隔でリトライしながら待つ
// （予約受付開始時刻ちょうどにカレンダーがまだ更新されていない場合等に使う）。
// 毎回openReservationFlowからやり直す（ログインセッションはpageに残ったままなので再ログインは不要）。
async function waitForDateAvailable(page, dateISO, { intervalMs = 2500, maxWaitMs = 15 * 60 * 1000, onTick } = {}) {
  const startedAt = Date.now();
  const [y, m] = dateISO.split('-').map(Number);
  let attempt = 0;
  while (true) {
    attempt++;
    await openReservationFlow(page);
    await goToMonth(page, y, m);
    const available = await isDateAvailable(page, dateISO);
    if (onTick) onTick({ attempt, available, elapsedMs: Date.now() - startedAt });
    if (available) return true;
    if (Date.now() - startedAt > maxWaitMs) return false;
    await page.waitForTimeout(intervalMs);
  }
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
  waitForDateAvailable,
  logError,
  screenshotStep,
};
