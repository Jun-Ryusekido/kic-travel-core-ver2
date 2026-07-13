// 日本時間(JST, UTC+9固定・サマータイムなし)基準での日付計算ユーティリティ。
// このスクリプトの実行サーバーがどのタイムゾーンであっても、
// 「解禁日」の判定が予約サイト側（日本国内サービス）の想定する日付とズレないよう、
// 常にJSTで計算する。

function getTodayJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
}

// dateStr: "YYYY-MM-DD" 形式。カレンダー日付としての単純な引き算（時刻・タイムゾーンの影響を受けないようUTC計算する）
function subtractDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// "2026-09-27T18:40:00" -> "2026/09/27"（サイト側の日付フォーマット）
function toSiteDateFormat(isoDateTime) {
  return isoDateTime.slice(0, 10).replace(/-/g, '/');
}

// "2026-09-27T18:40:00" -> "2026/09/27 18:40"（サイト側の data-usage-timestamp 形式）
function toSiteTimestampFormat(isoDateTime) {
  return `${toSiteDateFormat(isoDateTime)} ${isoDateTime.slice(11, 16)}`;
}

// ログ・スクリーンショットのファイル名用タイムスタンプ（JST）
function timestampForFilename() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mm = String(jst.getUTCMinutes()).padStart(2, '0');
  const ss = String(jst.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function dateForFilename() {
  return timestampForFilename().slice(0, 8);
}

// "2026-08-12T11:00:00" -> { year:2026, month:8, day:12, hour:11, minute:0 }
// （予約フォームの利用終了日時セレクトボックスへの入力用。文字列スライスで解析するため
// 実行環境のタイムゾーンに影響されない）
function toSiteTimeParts(isoDateTime) {
  return {
    year: Number(isoDateTime.slice(0, 4)),
    month: Number(isoDateTime.slice(5, 7)),
    day: Number(isoDateTime.slice(8, 10)),
    hour: Number(isoDateTime.slice(11, 13)),
    minute: Number(isoDateTime.slice(14, 16)),
  };
}

// 利用終了日時の「分」セレクトは 0/20/40 の3択のみのため、直近の選択肢に切り下げる
function roundMinuteToSiteOption(minute) {
  if (minute >= 40) return 40;
  if (minute >= 20) return 20;
  return 0;
}

// 今日(JST)から指定months分先の年月を { year, month } で返す（月初基準）
function addMonthsToTodayJST(months) {
  const today = getTodayJST(); // "YYYY-MM-DD"
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const total = (y * 12 + (m - 1)) + months;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

// 指定年月(year, 1-12のmonth)の日数
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// 指定年月の全日付を "YYYY-MM-DD" の配列で返す
function allDatesInMonth(year, month) {
  const n = daysInMonth(year, month);
  const mm = String(month).padStart(2, '0');
  const dates = [];
  for (let d = 1; d <= n; d++) dates.push(`${year}-${mm}-${String(d).padStart(2, '0')}`);
  return dates;
}

module.exports = { getTodayJST, subtractDays, toSiteDateFormat, toSiteTimestampFormat, timestampForFilename, dateForFilename, toSiteTimeParts, roundMinuteToSiteOption, addMonthsToTodayJST, daysInMonth, allDatesInMonth };
