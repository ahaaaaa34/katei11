/**
 * FOMC 会合日程の自動取得。
 *
 * 会合日程だけは計算では出せず、Fed が公表したものを読むしかない。
 * ここでは公式ページを読みに行くが、**手入力の日程（02_meetings.js）を
 * 上書きすることは絶対にしない**。埋めるのは「手入力が尽きた先の年」だけ。
 *
 * 相手は HTML なので、いつ形が変わってもおかしくない。そこで
 *
 *   抽出はゆるく、採用は厳しく
 *
 * という方針を取る。取り出したものが「FOMC の年間日程として辻褄が合うか」
 * （年8回前後・すべて火〜木・間隔が5〜10週）を検査し、ひとつでも外れたら
 * 丸ごと捨てて、従来どおりメールで手入力を促す。
 * 間違った金利発表日が静かに入るくらいなら、何も入らない方がましなので。
 */

const FOMC_CALENDAR_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const PROP_FOMC_AUTO = '_fomcAuto';
const PROP_FOMC_AUTO_MAILED = '_fomcAutoMailed';

/** 取得結果はこの日数だけ使い回す（毎回取りに行く必要はない）。 */
const FOMC_AUTO_TTL_DAYS = 7;

/** 手入力の日程がこの日数より先まであるなら、そもそも取りに行かない。 */
const FOMC_AUTO_TRIGGER_DAYS = 180;

const MONTH_NAMES = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** SEP（経済見通し）が公表される会合の月。アスタリスクが読めなかったときの当て。 */
const SEP_MONTHS = [3, 6, 9, 12];

// ---------------------------------------------------------------------------
// 手入力 ＋ 自動取得の合成
// ---------------------------------------------------------------------------

/**
 * その中央銀行の会合日程を返す。FOMC だけは、手入力が尽きた先の年を
 * 公式ページからの取得で補う。手入力がある年には一切手を触れない。
 */
function allMeetings_(bank) {
  const section = MEETINGS[bank] || {};
  const curated = (section.meetings || []).map(function (entry) {
    return { date: entry.date, sep: !!entry.sep, auto: false };
  });
  if (bank !== 'fomc' || !CONFIG.providers.fomcAutoFetch) return curated;

  let maxYear = 0;
  curated.forEach(function (entry) {
    const year = parseDateKey_(entry.date).getUTCFullYear();
    if (year > maxYear) maxYear = year;
  });

  const auto = autoFomcMeetings_(curated);
  const merged = curated.slice();
  Object.keys(auto).forEach(function (year) {
    if (Number(year) <= maxYear) return;   // 手入力がある年は触らない
    auto[year].forEach(function (entry) {
      merged.push({ date: entry.date, sep: entry.sep, auto: true });
    });
  });
  return merged.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}

/** 自動取得ぶんの会合日程（年 → 配列）。キャッシュ付き。 */
function autoFomcMeetings_(curated) {
  const cached = readAutoCache_();
  const fresh = cached && (Date.now() - cached.fetchedAt) < FOMC_AUTO_TTL_DAYS * 86400000;
  if (fresh) return cached.years;
  if (!needsAutoFomc_(curated)) return cached ? cached.years : {};

  const html = fetchText_(FOMC_CALENDAR_URL);
  if (html === null) {
    log_('FOMC 公式ページを取得できませんでした。手入力の日程だけで動きます。');
    return cached ? cached.years : {};
  }

  let years;
  try {
    years = parseFomcCalendar_(html);
  } catch (err) {
    log_('FOMC 公式ページを解釈できませんでした: ' + err);
    return cached ? cached.years : {};
  }

  const accepted = {};
  Object.keys(years).forEach(function (year) {
    const problem = validateFomcYear_(years[year], Number(year));
    if (problem) {
      log_('FOMC ' + year + ' 年の日程は検査に通らなかったので採用しません: ' + problem);
      return;
    }
    accepted[year] = years[year];
  });

  writeAutoCache_(accepted);
  maybeMailFomcSnippet_(accepted, curated);
  log_('FOMC 自動取得: ' + Object.keys(accepted).join(', ') + ' 年ぶんを採用');
  return accepted;
}

/** 手入力がまだ十分先まであるなら、取りに行かない。 */
function needsAutoFomc_(curated) {
  if (!curated.length) return true;
  let last = '';
  curated.forEach(function (entry) { if (entry.date > last) last = entry.date; });
  const horizon = addDays_(localDate_(new Date(), CONFIG.timezone), FOMC_AUTO_TRIGGER_DAYS);
  return parseDateKey_(last).getTime() < horizon.getTime();
}

function readAutoCache_() {
  const raw = prop_(PROP_FOMC_AUTO);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.years ? parsed : null;
  } catch (err) {
    return null;
  }
}

function writeAutoCache_(years) {
  try {
    props_().setProperty(PROP_FOMC_AUTO,
                         JSON.stringify({ fetchedAt: Date.now(), years: years }));
  } catch (err) {
    log_('取得結果を保存できませんでした: ' + err);
  }
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** タグを空白に潰して、日付らしき並びだけを拾える平文にする。 */
function htmlToText_(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8211;|&ndash;|&#8212;|&mdash;/g, '-')
    .replace(/\s+/g, ' ');
}

/**
 * ページ全体から「YYYY 年の会合一覧」を取り出す。
 * クラス名には依存せず、"2027 FOMC Meetings" のような見出しを起点にする。
 */
function parseFomcCalendar_(html) {
  const text = htmlToText_(html);
  const headings = [];
  const headingRe = /(\d{4})\s+FOMC\s+Meetings/gi;
  let match;
  while ((match = headingRe.exec(text)) !== null) {
    headings.push({ year: Number(match[1]), index: match.index });
  }

  const out = {};
  headings.forEach(function (heading, i) {
    const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
    const meetings = parseFomcYear_(text.slice(heading.index, end), heading.year);
    if (meetings.length) out[heading.year] = meetings;
  });
  return out;
}

/**
 * 1年ぶんの "January 27-28" / "April/May 28-1*" のような並びを読む。
 * 政策金利が出るのは会合の最終日なので、範囲の後ろの日を採る。
 */
function parseFomcYear_(text, year) {
  const month = '(' + Object.keys(MONTH_NAMES).join('|') + ')';
  const re = new RegExp(
    month + '(?:\\s*/\\s*' + month + ')?\\s+(\\d{1,2})\\s*[-‐-―]\\s*(\\d{1,2})\\s*(\\*?)',
    'gi');

  const meetings = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const startMonth = MONTH_NAMES[match[1].toLowerCase()];
    const startDay = Number(match[3]);
    const endDay = Number(match[4]);
    let endMonth = match[2] ? MONTH_NAMES[match[2].toLowerCase()] : startMonth;
    // "April/May 28-1" のように月をまたぐ回。月名が1つしか無い場合でも
    // 終わりの日が始まりより小さければ翌月とみなす。
    if (!match[2] && endDay < startDay) endMonth = startMonth + 1;

    let endYear = year;
    if (endMonth > 12) { endMonth -= 12; endYear += 1; }

    meetings.push({
      date: dateKey_(ymd_(endYear, endMonth, endDay)),
      sep: match[5] === '*',
      starred: match[5] === '*',
      month: endMonth,
    });
  }

  // アスタリスクが読めていれば SEP はそれに従う。読めていなければ
  // 慣例（3/6/9/12月）で当てる。どちらでも注記の有無が変わるだけ。
  const starred = meetings.filter(function (m) { return m.starred; }).length;
  const trustStars = starred >= 3 && starred <= 5;
  return meetings.map(function (m) {
    return {
      date: m.date,
      sep: trustStars ? m.starred : SEP_MONTHS.indexOf(m.month) !== -1,
    };
  });
}

/**
 * 「FOMC の年間日程としてあり得る形か」を検査する。
 * 問題があれば理由の文字列を、無ければ null を返す。
 */
function validateFomcYear_(meetings, year) {
  if (meetings.length < 6 || meetings.length > 10) {
    return '会合数が ' + meetings.length + ' 回（通常は年8回）';
  }

  const seen = {};
  const dates = [];
  for (let i = 0; i < meetings.length; i++) {
    const key = meetings[i].date;
    if (seen[key]) return '同じ日付が重複: ' + key;
    seen[key] = true;

    const date = parseDateKey_(key);
    if (isNaN(date.getTime())) return '日付として読めない: ' + key;
    if (date.getUTCFullYear() !== year) return year + ' 年でない日付: ' + key;
    // 政策金利の発表は会合最終日で、実際には火〜木にしか来ない。
    const weekday = weekdayOf_(date);
    if (weekday < 1 || weekday > 3) return '平日中盤でない曜日: ' + key;
    dates.push(date);
  }

  dates.sort(function (a, b) { return a - b; });
  for (let i = 1; i < dates.length; i++) {
    const gap = daysBetween_(dates[i], dates[i - 1]);
    if (gap < 25 || gap > 75) {
      return '会合間隔が ' + gap + ' 日（' + dateKey_(dates[i - 1])
           + ' → ' + dateKey_(dates[i]) + '）';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 人間側への引き継ぎ
// ---------------------------------------------------------------------------

/**
 * 自動取得で新しい年が埋まったら、02_meetings.js に貼れる形で1度だけ送る。
 * 自動取得はあくまで保険なので、最終的には手元の定義に載せてもらうのが確実。
 */
function maybeMailFomcSnippet_(accepted, curated) {
  let maxCurated = 0;
  curated.forEach(function (entry) {
    const year = parseDateKey_(entry.date).getUTCFullYear();
    if (year > maxCurated) maxCurated = year;
  });

  const newYears = Object.keys(accepted).filter(function (year) {
    return Number(year) > maxCurated;
  }).sort();
  if (!newYears.length) return false;

  const signature = newYears.join(',');
  if (prop_(PROP_FOMC_AUTO_MAILED) === signature) return false;

  const snippet = newYears.map(function (year) {
    return accepted[year].map(function (entry) {
      return "      { date: '" + entry.date + "', sep: " + entry.sep + ' },';
    }).join('\n');
  }).join('\n');

  const body = [
    'FOMC の会合日程を Fed の公式ページから自動取得し、' + signature + ' 年ぶんを取り込みました。',
    'カレンダーはこのまま動き続けるので、急ぎの対応は要りません。',
    '',
    'ただし自動取得は公式ページの作りに依存します。確実にしておきたい場合は、',
    '下記を src/02_meetings.js の fomc.meetings に貼り付けてください（貼れば以後は',
    '手入力が優先され、取得は行われません）。',
    '',
    snippet,
    '',
    '※ 上の日程は公式ページの記載をそのまま読み取ったものですが、',
    '　 念のため ' + (MEETINGS.fomc.verify_url || '') + ' で照合することをおすすめします。',
  ].join('\n');

  sendMail_('[経済指標カレンダー] FOMC 日程を自動取得しました（' + signature + '）', body);
  try {
    props_().setProperty(PROP_FOMC_AUTO_MAILED, signature);
  } catch (err) {
    log_('通知状態を保存できませんでした: ' + err);
  }
  return true;
}
