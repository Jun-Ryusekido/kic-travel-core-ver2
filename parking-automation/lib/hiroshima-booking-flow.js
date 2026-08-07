// 広島城 中央公園バス駐車場予約システム(bus.hiroshimacastle.jp)の操作ロジック。
//
// 実際にJUNさんが予約フォーム(/reservations/new?...)とログインフォームのHTML構造を
// ブラウザの開発者ツールで確認し共有いただいた内容に基づく（2026年8月時点）。
// 新大阪(lib/booking-flow.js)・名古屋(lib/nagoya-booking-flow.js)と同じ構成方針
// （login→カレンダーで対象日時のセルを選ぶ→フォーム入力→送信）を踏襲している。
//
//   - ログインフォーム: メールアドレス <input type="email" name="email" id="email">、
//     パスワード <input type="password" name="password" id="pw_field">、
//     送信ボタン input[name="commit"][value="ログイン"]、POST先は /user_sessions
//     （CSRF対策のauthenticity_token隠しinputあり。フォームをそのままsubmitすれば
//     自動的に送信されるため、こちらで個別に扱う必要はない）。
//     ⚠️ ログイン画面自体のURL(GET)はJUNさんへの確認では未確認のため、Railsの
//     標準的な命名規則から /user_sessions/new と推測している。実際に異なる場合は
//     login()内のLOGIN_URLを実機で確認の上、修正すること。
//   - カレンダー画面: /reservations?start_date=YYYY-MM-DD。予約可能な日時のセルには
//     data-href属性（day=YYYY-MM-DD・time=HH:MM のクエリパラメータを含み、
//     /reservations/new へ遷移する）が付与されている（JUNさん確認）。
//     予約不可のセルにはdata-href属性が無いと想定し、[data-href]セレクタで
//     クリック可能なセルのみを対象にする。
//   - 入力フォーム(/reservations/new?...)のフィールド一覧（JUNさん確認、name属性）:
//       start_date / start_time … 隠しinput・readonly。カレンダーのセル選択時点で
//         自動セットされるため、こちらから入力する必要はない。
//       end_date … select（当日/翌日の2択、ラベルで選択する）
//       end_time … select（開始時刻より後の時刻のみ選択可、ラベルで選択する。
//         対象の分ちょうどの選択肢が無い場合は直近の選択可能な時刻に丸める）
//       capacity … 隠しinput（固定値、触らない）
//       reservation[payment_method] … 隠しinput（現地払い固定、触らない）
//       bus_count … select（1〜10、予約台数）
//       reservation[contact_name] / reservation[contact_tel] … text（当日連絡先、必須）
//       reservation[bus_type] … select（団体バス/定期観光バス/マイクロバス/タクシー/その他、必須）
//       reservation[destination][] … checkbox（複数選択可、利用施設、最低1つ必須）
//       reservation[bus_company] … text（任意）
//       reservation[passengers] … number 1〜60（任意）
//       reservation[customer] … text（任意、利用団体名）
//       reservation[user_remark] … textarea（任意）
//       送信: input[name="commit"][value="登録する"]
//   - 送信成功後の遷移先・完了メッセージの具体的な文言は未確認のため、
//     「/reservations/new から別のURLへ遷移したこと」を成功の判定に使う
//     （失敗時は同じフォームに留まり、エラーメッセージが表示される想定）。

const fs = require('fs');
const path = require('path');
const { dateForFilename, timestampForFilename } = require('./date-utils');

const BASE_URL = 'https://bus.hiroshimacastle.jp';
const LOGIN_URL = `${BASE_URL}/user_sessions/new`; // ⚠️ 未確認・推測（コメント参照）
const LOGS_DIR = path.join(__dirname, '..', 'logs');

function logError(message) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, `hiroshima-error-${dateForFilename()}.log`);
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

async function login(page, email, password) {
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  const emailField = await page.$('#email');
  const pwField = await page.$('#pw_field');
  if (!emailField || !pwField) {
    throw new Error(`ログインフォームが見つかりませんでした（${LOGIN_URL}）。LOGIN_URLが実際のログイン画面と異なる可能性があります`);
  }
  await page.fill('#email', email);
  await page.fill('#pw_field', password);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null),
    page.click('input[name="commit"][value="ログイン"]'),
  ]);
  // ログイン失敗時はログインフォームに留まる想定（#pw_fieldがまだ存在するかで判定）
  const stillOnLogin = await page.$('#pw_field');
  if (stillOnLogin) {
    throw new Error('ログインに失敗しました（ログインフォームに留まっています。hiroshima-config.jsonのemail/passwordをご確認ください）');
  }
}

// "2026-09-01T18:00:00" -> "2026-09-01"
function toDateOnly(isoDateTime) {
  return isoDateTime.slice(0, 10);
}
// "2026-09-01T18:00:00" -> "18:00"
function toTimeOnly(isoDateTime) {
  return isoDateTime.slice(11, 16);
}

// カレンダー画面(/reservations?start_date=YYYY-MM-DD)で対象の開始日時に対応する
// セルを探してクリックし、予約フォーム(/reservations/new?...)へ遷移する。
// 完全一致するセルが無い場合、同じ日付の予約可能セルの中から時刻が最も近いものを選ぶ
// （新大阪のfindSlot()と同じフォールバック方針）。
async function selectStartDateTime(page, startDateTime) {
  const dateStr = toDateOnly(startDateTime);
  const timeStr = toTimeOnly(startDateTime);

  await page.goto(`${BASE_URL}/reservations?start_date=${dateStr}`, { waitUntil: 'networkidle' });

  const exact = await page.$(`[data-href*="day=${dateStr}"][data-href*="time=${timeStr}"]`);
  let target = exact;

  if (!target) {
    const candidates = await page.$$(`[data-href*="day=${dateStr}"]`);
    if (candidates.length === 0) {
      throw new Error(`カレンダー上に対象日(${dateStr})の予約可能な枠が見つかりませんでした`);
    }
    const timeToMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
    const targetMinutes = timeToMinutes(timeStr);
    let best = null;
    let bestDiff = Infinity;
    for (const c of candidates) {
      const href = await c.getAttribute('data-href');
      const m = href.match(/time=(\d{2}:\d{2})/);
      if (!m) continue;
      const diff = Math.abs(timeToMinutes(m[1]) - targetMinutes);
      if (diff < bestDiff) { bestDiff = diff; best = c; }
    }
    if (!best) throw new Error(`カレンダー上に対象日(${dateStr})の予約可能な時刻枠が見つかりませんでした`);
    target = best;
  }

  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null),
    target.click(),
  ]);

  if (!/\/reservations\/new/.test(page.url())) {
    throw new Error(`予約フォームへ遷移しませんでした（現在のURL: ${page.url()}）`);
  }
}

// select要素に対し、ラベル文字列で選択を試みる。完全一致が無ければ部分一致で
// 一番近いものを選ぶ（end_time等、サイト側の選択肢の分の刻みが不明なため）。
async function selectByLabelFuzzy(page, selector, labelText) {
  try {
    await page.selectOption(selector, { label: labelText });
    return;
  } catch (e) {
    // 完全一致なし → 選択可能なoptionの中から最も近い時刻のものを選ぶ
  }
  const options = await page.$$eval(selector + ' option', (opts) =>
    opts.filter((o) => !o.disabled).map((o) => ({ value: o.value, label: (o.textContent || '').trim() }))
  );
  if (options.length === 0) {
    throw new Error(`${selector} に選択可能な選択肢がありませんでした`);
  }
  const timeToMinutes = (s) => {
    const m = s.match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const targetMinutes = timeToMinutes(labelText);
  if (targetMinutes == null) {
    // 時刻形式でない（例: 当日/翌日）場合は先頭の選択肢にフォールバック
    await page.selectOption(selector, { value: options[0].value });
    return;
  }
  let best = options[0];
  let bestDiff = Infinity;
  for (const o of options) {
    const mins = timeToMinutes(o.label);
    if (mins == null) continue;
    const diff = Math.abs(mins - targetMinutes);
    if (diff < bestDiff) { bestDiff = diff; best = o; }
  }
  await page.selectOption(selector, { value: best.value });
}

async function fillReservationForm(page, reservation) {
  const startDate = toDateOnly(reservation.startDateTime);
  const endDate = toDateOnly(reservation.endDateTime);
  const endLabel = endDate === startDate ? '当日' : '翌日';
  await selectByLabelFuzzy(page, 'select[name="end_date"]', endLabel);
  await selectByLabelFuzzy(page, 'select[name="end_time"]', toTimeOnly(reservation.endDateTime));

  await page.selectOption('select[name="bus_count"]', String(reservation.busCount || 1));
  await page.selectOption('select[name="reservation[bus_type]"]', { label: reservation.busType });

  await page.fill('input[name="reservation[contact_name]"]', reservation.contactName);
  await page.fill('input[name="reservation[contact_tel]"]', reservation.contactTel);

  for (const dest of reservation.destinations || []) {
    const cb = page.locator(`input[name="reservation[destination][]"][value="${dest}"]`);
    if ((await cb.count()) === 0) {
      throw new Error(`利用施設「${dest}」のチェックボックスが見つかりませんでした`);
    }
    await cb.check();
  }

  if (reservation.busCompany) await page.fill('input[name="reservation[bus_company]"]', reservation.busCompany);
  if (reservation.passengers) await page.fill('input[name="reservation[passengers]"]', String(reservation.passengers));
  if (reservation.customer) await page.fill('input[name="reservation[customer]"]', reservation.customer);
  if (reservation.remarks) await page.fill('textarea[name="reservation[user_remark]"]', reservation.remarks);

  const urlBefore = page.url();
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null),
    page.click('input[name="commit"][value="登録する"]'),
  ]);
  if (page.url() === urlBefore) {
    throw new Error('登録ボタン押下後もフォーム画面に留まっています（入力内容にエラーがある可能性があります。画面のエラーメッセージをご確認ください）');
  }
}

// 1件分の予約処理（ログイン後の状態のpageを渡すこと）。成功時はスクリーンショットのパスを返す。
async function processReservation(page, reservation) {
  await selectStartDateTime(page, reservation.startDateTime);
  await fillReservationForm(page, reservation);

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const screenshotPath = path.join(LOGS_DIR, `hiroshima-${reservation.refNumber}-${timestampForFilename()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  return { screenshotPath };
}

module.exports = { BASE_URL, LOGIN_URL, login, selectStartDateTime, fillReservationForm, processReservation, logError, LOGS_DIR };
