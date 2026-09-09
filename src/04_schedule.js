/**
 * 米国の休日カレンダーと、発表日の繰り返しルール。
 *
 * 日付は「UTC 深夜の Date」で持ち回る。実行環境のローカル時刻に一切
 * 依存させないための約束事で、時刻を持つのは zonedTime_ を通したあとだけ。
 * 曜日は Python 版に合わせて月曜=0 で扱う。
 */

const ET = 'America/New_York';
const WEEKDAY_NUM = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
const WEEKDAY_JA = ['月', '火', '水', '木', '金', '土', '日'];

// ---------------------------------------------------------------------------
// 日付の基本操作
// ---------------------------------------------------------------------------

function ymd_(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKey_(date) {
  return date.getUTCFullYear() + '-' + pad2_(date.getUTCMonth() + 1) + '-' + pad2_(date.getUTCDate());
}

function parseDateKey_(text) {
  const parts = String(text).slice(0, 10).split('-');
  return ymd_(+parts[0], +parts[1], +parts[2]);
}

function addDays_(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

/** 月曜=0 の曜日番号。 */
function weekdayOf_(date) {
  return (date.getUTCDay() + 6) % 7;
}

function daysBetween_(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

function lastDayOfMonth_(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// タイムゾーン
// ---------------------------------------------------------------------------

/**
 * ある瞬間における、そのタイムゾーンの UTC からのずれ（分）。
 * Intl を主経路にしているのは、Node のテストで検証できる形を保つため。
 */
function tzOffsetMinutes_(instant, timezone) {
  try {
    const parts = tzParts_(instant, timezone);
    const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day,
                           parts.hour, parts.minute, parts.second);
    return Math.round((asUTC - instant.getTime()) / 60000);
  } catch (err) {
    // Intl が使えない環境向けの保険（GAS 標準 API）。
    const text = Utilities.formatDate(instant, timezone, 'Z');  // 例 "-0400"
    const sign = text.charAt(0) === '-' ? -1 : 1;
    return sign * (parseInt(text.substr(1, 2), 10) * 60 + parseInt(text.substr(3, 2), 10));
  }
}

function tzParts_(instant, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out = {};
  formatter.formatToParts(instant).forEach(function (part) {
    if (part.type !== 'literal') out[part.type] = parseInt(part.value, 10);
  });
  // ICU の版によっては真夜中を 24 時と返す。ここで 0 に寄せておかないと
  // 呼び出し側それぞれで % 24 を書く羽目になり、書き忘れが必ず起きる。
  out.hour = out.hour % 24;
  return out;
}

/**
 * 「その日の HH:MM（指定タイムゾーンの壁時計）」を実際の瞬間に変換する。
 * ずれの分だけ戻したあと、境界（夏時間の切替日）で答えが変わる場合に
 * もう一度補正するので、切替日でも正しい値になる。
 */
function zonedTime_(date, hhmm, timezone) {
  const bits = String(hhmm).split(':');
  const wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
                        parseInt(bits[0], 10), parseInt(bits[1], 10));
  const first = tzOffsetMinutes_(new Date(wall), timezone);
  let instant = new Date(wall - first * 60000);
  const second = tzOffsetMinutes_(instant, timezone);
  if (second !== first) instant = new Date(wall - second * 60000);
  return instant;
}

/** ある瞬間を、指定タイムゾーンでの「日付（UTC深夜の Date）」に落とす。 */
function localDate_(instant, timezone) {
  const parts = tzParts_(instant, timezone);
  return ymd_(parts.year, parts.month, parts.day);
}

// ---------------------------------------------------------------------------
// 祝日
// ---------------------------------------------------------------------------

/** グレゴリオ暦の復活祭（Meeus のアルゴリズム）。グッドフライデーの算出用。 */
function easter_(year) {
  const a = year % 19;
  const b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd_(year, month, day);
}

/** 月の第 n 曜日。n が負なら最後から数える（-1 = 最終）。 */
function nthWeekday_(year, month, weekday, n) {
  if (n < 0) {
    let date = ymd_(year, month, lastDayOfMonth_(year, month));
    while (weekdayOf_(date) !== weekday) date = addDays_(date, -1);
    return date;
  }
  let date = ymd_(year, month, 1);
  date = addDays_(date, (weekday - weekdayOf_(date) + 7) % 7);
  return addDays_(date, (n - 1) * 7);
}

/** 連邦の振替ルール：土曜は前日の金曜、日曜は翌日の月曜。 */
function observed_(date) {
  const weekday = weekdayOf_(date);
  if (weekday === 5) return addDays_(date, -1);
  if (weekday === 6) return addDays_(date, 1);
  return date;
}

/** 統計局が閉まる連邦休日。 */
function federalHolidays_(year) {
  const out = {};
  out[dateKey_(observed_(ymd_(year, 1, 1)))] = '元日';
  out[dateKey_(nthWeekday_(year, 1, WEEKDAY_NUM.mon, 3))] = 'キング牧師記念日';
  out[dateKey_(nthWeekday_(year, 2, WEEKDAY_NUM.mon, 3))] = '大統領の日';
  out[dateKey_(nthWeekday_(year, 5, WEEKDAY_NUM.mon, -1))] = '戦没者追悼記念日';
  out[dateKey_(observed_(ymd_(year, 6, 19)))] = 'ジューンティーンス';
  out[dateKey_(observed_(ymd_(year, 7, 4)))] = '独立記念日';
  out[dateKey_(nthWeekday_(year, 9, WEEKDAY_NUM.mon, 1))] = 'レイバーデー';
  out[dateKey_(nthWeekday_(year, 10, WEEKDAY_NUM.mon, 2))] = 'コロンブスデー';
  out[dateKey_(observed_(ymd_(year, 11, 11)))] = 'ベテランズデー';
  out[dateKey_(nthWeekday_(year, 11, WEEKDAY_NUM.thu, 4))] = '感謝祭';
  out[dateKey_(observed_(ymd_(year, 12, 25)))] = 'クリスマス';
  return out;
}

/**
 * NYSE / ナスダックの終日休場。
 * 連邦休日とは違い、コロンブスデーとベテランズデーは取引があり、
 * 代わりにグッドフライデーが休みになる。元日が土曜のときは前日の金曜を
 * 休場にしない点も連邦ルールと異なる。
 */
function marketHolidays_(year) {
  const raw = {};
  raw[dateKey_(nthWeekday_(year, 1, WEEKDAY_NUM.mon, 3))] = 'キング牧師記念日';
  raw[dateKey_(nthWeekday_(year, 2, WEEKDAY_NUM.mon, 3))] = '大統領の日';
  raw[dateKey_(addDays_(easter_(year), -2))] = 'グッドフライデー';
  raw[dateKey_(nthWeekday_(year, 5, WEEKDAY_NUM.mon, -1))] = '戦没者追悼記念日';
  raw[dateKey_(observed_(ymd_(year, 6, 19)))] = 'ジューンティーンス';
  raw[dateKey_(observed_(ymd_(year, 7, 4)))] = '独立記念日';
  raw[dateKey_(nthWeekday_(year, 9, WEEKDAY_NUM.mon, 1))] = 'レイバーデー';
  raw[dateKey_(nthWeekday_(year, 11, WEEKDAY_NUM.thu, 4))] = '感謝祭';
  raw[dateKey_(observed_(ymd_(year, 12, 25)))] = 'クリスマス';

  const newYear = ymd_(year, 1, 1);
  if (weekdayOf_(newYear) !== 5) raw[dateKey_(observed_(newYear))] = '元日';

  const out = {};
  Object.keys(raw).forEach(function (key) {
    if (weekdayOf_(parseDateKey_(key)) < 5) out[key] = raw[key];
  });
  return out;
}

/** 13:00 ET で引ける半日。 */
function marketEarlyCloses_(year) {
  const raw = {};
  const july3 = ymd_(year, 7, 3);
  if (weekdayOf_(july3) < 5 && weekdayOf_(ymd_(year, 7, 4)) < 5) {
    raw[dateKey_(july3)] = '独立記念日前日';
  }
  raw[dateKey_(addDays_(nthWeekday_(year, 11, WEEKDAY_NUM.thu, 4), 1))] = '感謝祭翌日';
  const dec24 = ymd_(year, 12, 24);
  if (weekdayOf_(dec24) < 5) raw[dateKey_(dec24)] = 'クリスマスイブ';

  const holidays = marketHolidays_(year);
  const out = {};
  Object.keys(raw).forEach(function (key) {
    if (!holidays[key]) out[key] = raw[key];
  });
  return out;
}

function isBusinessDay_(date, holidays) {
  if (weekdayOf_(date) >= 5) return false;
  const table = holidays || federalHolidays_(date.getUTCFullYear());
  return !table[dateKey_(date)];
}

function nextBusinessDay_(date) {
  let out = date;
  while (!isBusinessDay_(out)) out = addDays_(out, 1);
  return out;
}

function businessDaysInMonth_(year, month) {
  const holidays = federalHolidays_(year);
  const out = [];
  const last = lastDayOfMonth_(year, month);
  for (let day = 1; day <= last; day++) {
    const date = ymd_(year, month, day);
    if (isBusinessDay_(date, holidays)) out.push(date);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 繰り返しルール
// ---------------------------------------------------------------------------

/**
 * ルールを [start, end] の範囲の具体的な日付に展開する。
 *
 *   nth_business_day  月の第 n 営業日（負なら末尾から。-1 = 最終営業日）
 *   nth_weekday       月の第 n 曜日（-1 = 最終）
 *   day_of_month      固定日。休日なら翌営業日へずらす
 *   weekly            毎週その曜日。祝日に当たる週は前倒し（失業保険の挙動）
 */
function ruleDates_(rule, start, end) {
  const kind = (rule && rule.type) || 'none';
  if (kind === 'none') return [];
  const months = rule.months || null;
  const seen = {};
  const out = [];

  function push(date) {
    if (!date) return;
    if (date.getTime() < start.getTime() || date.getTime() > end.getTime()) return;
    if (months && months.indexOf(date.getUTCMonth() + 1) === -1) return;
    const key = dateKey_(date);
    if (seen[key]) return;
    seen[key] = true;
    out.push(date);
  }

  if (kind === 'weekly') {
    const weekday = WEEKDAY_NUM[rule.weekday || 'thu'];
    let cursor = addDays_(start, (weekday - weekdayOf_(start) + 7) % 7);
    while (cursor.getTime() <= end.getTime()) {
      let candidate = cursor;
      // 週の中に祝日があると発表が前倒しになるので、休日なら手前へ寄せる。
      if (federalHolidays_(candidate.getUTCFullYear())[dateKey_(candidate)]) {
        candidate = addDays_(candidate, -1);
        while (!isBusinessDay_(candidate)) candidate = addDays_(candidate, -1);
      }
      push(candidate);
      cursor = addDays_(cursor, 7);
    }
    return sortDates_(out);
  }

  eachMonth_(start, end, function (year, month) {
    if (months && months.indexOf(month) === -1) return;
    if (kind === 'nth_business_day') {
      const days = businessDaysInMonth_(year, month);
      const n = rule.n === undefined ? 1 : rule.n;
      const index = n > 0 ? n - 1 : days.length + n;
      if (index >= 0 && index < days.length) push(days[index]);
    } else if (kind === 'nth_weekday') {
      const date = nthWeekday_(year, month, WEEKDAY_NUM[rule.weekday || 'fri'],
                               rule.n === undefined ? 1 : rule.n);
      if (date.getUTCMonth() + 1 === month) push(date);
    } else if (kind === 'day_of_month') {
      push(nextBusinessDay_(ymd_(year, month, Math.min(rule.day || 1, 28))));
    } else {
      throw new Error('未知のスケジュール種別: ' + kind);
    }
  });
  return sortDates_(out);
}

function eachMonth_(start, end, callback) {
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1;
  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth() + 1;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    callback(year, month);
    if (month === 12) { year++; month = 1; } else { month++; }
  }
}

function sortDates_(dates) {
  return dates.slice().sort(function (a, b) { return a.getTime() - b.getTime(); });
}
