/**
 * 通信を伴う情報源。取得できなければ空配列を返し、同期そのものは続行する。
 */

// ---------------------------------------------------------------------------
// FRED — セントルイス連銀が公開している「公式の発表日」。
// 日付だけを返してくるので、時刻はカタログの標準発表時刻を当てる。
// 無料 API キー: https://fred.stlouisfed.org/docs/api/api_key.html
// ---------------------------------------------------------------------------

const FRED_API = 'https://api.stlouisfed.org/fred';
const FRED_PAGE = 1000;

// 対応付けの誤りを「規則からの距離」で検知しようとしたが、成立しなかった。
// 週次規則からはどんな日付も最大4日、月次規則からも最大16日しか離れられず、
// 誤対応を見分けられる幅が残らない（実測して確認した）。
// 代わりに「ひとつの指標に複数の release 名が当たっていないか」で見る。
// 規則の当たり具合そのものは measureRuleAccuracy_ で別途測る。

function providerFred_(ctx) {
  const apiKey = prop_(PROP_FRED_KEY);
  if (!apiKey) {
    log_('FRED: API キー未設定のためスキップ（スクリプト プロパティ ' + PROP_FRED_KEY + '）');
    return [];
  }

  // 米東部の発表日と表示タイムゾーンの日付は1日ずれることがあるので、
  // 前後1日ぶん広く取ってから表示日で絞る。
  const rows = fredReleaseDates_(apiKey, addDays_(ctx.start, -1), addDays_(ctx.end, 1));
  if (rows === null) {
    // つながらなかっただけ。既に書き込んである公式日程を消させない。
    markSourceDown_('fred', 'FRED に接続できませんでした');
    return [];
  }

  const events = [];
  // ひとつの指標に複数の release 名が当たったら、正規表現が緩すぎる合図。
  // 関係ない発表日が「公式の日付」として混ざるので、見つけたら知らせる。
  const matchedNames = {};
  const suspicious = [];

  rows.forEach(function (row) {
    if (!row || typeof row !== 'object') return;
    const name = row.release_name || '';
    if (!name) return;
    const indicator = matchFredRelease_(name);
    if (!indicator) return;
    const day = parseDateKey_(row.date);
    if (!day) return;   // 読めない日付の行は飛ばす（そこだけ捨てる）
    matchedNames[indicator.id] = matchedNames[indicator.id] || {};
    matchedNames[indicator.id][name] = true;
    const start = zonedTime_(day, indicator.time, indicatorTimezone_(indicator));
    if (!inDisplayWindow_(start, ctx)) return;
    events.push(makeEvent_({
      indicatorId: indicator.id,
      title: indicator.name,
      start: start,
      end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
      impact: indicator.impact,
      country: indicator.country,
      category: indicator.category,
      source: 'fred',
      confidence: 'official',   // 統計局の公表日程そのもの
      period: periodLabel_(day, indicator.period_offset || 0),
      note: indicator.why,
      url: indicator.url,
      extra: { fredRelease: name },
    }));
  });
  Object.keys(matchedNames).forEach(function (id) {
    const names = Object.keys(matchedNames[id]);
    if (names.length > 1) {
      suspicious.push(id + ' ← ' + names.length + ' 種類の release に一致: '
                      + names.join(' / '));
    }
  });
  if (suspicious.length) {
    log_('FRED の対応付けに疑いがあります:\n  ' + suspicious.join('\n  '));
  }
  FRED_LAST_WARNINGS_ = suspicious;

  log_('FRED: ' + rows.length + ' 件中 ' + events.length + ' 件が該当');
  return events;
}

/** 直近の取得で見つかった、対応付けの疑い（データ品質の点検で使う）。 */
let FRED_LAST_WARNINGS_ = [];

function fredMatchWarnings_() {
  return FRED_LAST_WARNINGS_.slice();
}

/**
 * その指標の発表規則が予想する日と、実際の日付との最小の隔たり（日）。
 * 規則を持たない指標は判定できないので null を返す。
 */
function ruleDistanceDays_(indicator, day) {
  if (!indicator.schedule || !indicator.schedule.type
      || indicator.schedule.type === 'none') {
    return null;
  }
  const predicted = ruleDates_(indicator.schedule,
                               addDays_(day, -45), addDays_(day, 45));
  if (!predicted.length) return null;
  let best = Infinity;
  predicted.forEach(function (date) {
    best = Math.min(best, Math.abs(daysBetween_(date, day)));
  });
  return best;
}

/**
 * 発表規則がどれだけ当たっているかを、FRED の実績で測る。
 *
 * 「第1営業日」「毎週木曜」といった規則は人が書いたものなので、
 * 当たっているかどうかは測らないと分からない。過去の実際の発表日と
 * 突き合わせて、指標ごとの的中率とずれを出す。
 */
function measureRuleAccuracy_(months) {
  const apiKey = prop_(PROP_FRED_KEY);
  if (!apiKey) return null;

  const today = localDate_(new Date(), CONFIG.timezone);
  const from = addDays_(today, -30 * (months || 12));
  const rows = fredReleaseDates_(apiKey, from, today);
  if (rows === null) return null;

  const stats = {};
  rows.forEach(function (row) {
    if (!row || typeof row !== 'object') return;
    const name = row.release_name || '';
    const indicator = name ? matchFredRelease_(name) : null;
    if (!indicator) return;
    const gap = ruleDistanceDays_(indicator, parseDateKey_(row.date));
    if (gap === null) return;
    const entry = stats[indicator.id]
      || (stats[indicator.id] = { id: indicator.id, name: indicator.name,
                                  samples: 0, exact: 0, total: 0, worst: 0 });
    entry.samples++;
    entry.total += gap;
    if (gap === 0) entry.exact++;
    if (gap > entry.worst) entry.worst = gap;
  });

  return Object.keys(stats).map(function (id) {
    const entry = stats[id];
    entry.meanGap = Math.round((entry.total / entry.samples) * 10) / 10;
    entry.exactRate = Math.round((entry.exact / entry.samples) * 100);
    return entry;
  }).sort(function (a, b) { return b.meanGap - a.meanGap; });
}

function fredReleaseDates_(apiKey, start, end) {
  const rows = [];
  let offset = 0;
  for (let guard = 0; guard < 20; guard++) {
    const url = FRED_API + '/releases/dates?' + [
      'api_key=' + encodeURIComponent(apiKey),
      'file_type=json',
      'realtime_start=' + dateKey_(start),
      'realtime_end=' + dateKey_(end),
      'include_release_dates_with_no_data=true',
      'sort_order=asc',
      'limit=' + FRED_PAGE,
      'offset=' + offset,
    ].join('&');

    const payload = fetchJson_(url);
    if (payload === null) return rows.length ? rows : null;
    // 応答の形が変わって配列でなくなっても、そこで落ちない。
    const page = Array.isArray(payload.release_dates) ? payload.release_dates : [];
    page.forEach(function (row) { rows.push(row); });
    offset += FRED_PAGE;
    if (page.length < FRED_PAGE || offset >= (payload.count || 0)) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// earnings — ナスダック100の主要銘柄の決算日。
// 指標ではないが、NVDA や AAPL の1本は多くのマクロ指標より指数を動かす。
// ---------------------------------------------------------------------------

const NASDAQ_EARNINGS = 'https://api.nasdaq.com/api/calendar/earnings?date=';
const EARNINGS_BATCH = 15;   // 実行時間の上限があるのでまとめて取りに行く

const EARNINGS_SESSIONS = {
  'time-pre-market': { time: '07:00', label: '寄り前' },
  'time-after-hours': { time: '16:15', label: '引け後' },
  'time-not-supplied': { time: '16:15', label: '時刻未定' },
};

function providerEarnings_(ctx) {
  const tickers = CONFIG.earningsTickers || {};
  if (!Object.keys(tickers).length) return [];

  // 16:15 ET の引け後決算は日本時間だと翌朝になる。窓の初日ぶんを取りこぼさない
  // よう、米東部の日付では前後1日ぶん多めに見て、最後に表示日で絞る。
  const days = [];
  const from = addDays_(ctx.start, -1);
  const to = addDays_(ctx.end, 1);
  for (let day = from; day.getTime() <= to.getTime(); day = addDays_(day, 1)) {
    if (weekdayOf_(day) < 5 && !federalHolidays_(day.getUTCFullYear())[dateKey_(day)]) {
      days.push(day);
    }
  }

  const events = [];
  let failures = 0;
  for (let i = 0; i < days.length; i += EARNINGS_BATCH) {
    const chunk = days.slice(i, i + EARNINGS_BATCH);
    const responses = fetchAllJson_(chunk.map(function (day) {
      return NASDAQ_EARNINGS + dateKey_(day);
    }));
    responses.forEach(function (payload, index) {
      if (payload === null) {
        failures++;
        // 取れなかった日の決算は「無い」のではなく「分からない」。
        markSourceDown_('earnings', '決算カレンダーの一部を取得できませんでした');
        return;
      }
      const rows = (payload.data && payload.data.rows) || [];
      rows.forEach(function (row) {
        const event = earningsEvent_(chunk[index], row, tickers);
        if (event && inDisplayWindow_(event.start, ctx)) events.push(event);
      });
    });
    if (failures >= EARNINGS_BATCH) {
      log_('決算カレンダーに繰り返し接続できないため中止しました');
      return events;
    }
  }
  log_('earnings: ' + events.length + ' 件');
  return events;
}

function earningsEvent_(day, row, tickers) {
  const symbol = String(row.symbol || '').trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(tickers, symbol)) return null;

  const session = EARNINGS_SESSIONS[row.time] || EARNINGS_SESSIONS['time-not-supplied'];
  const start = zonedTime_(day, session.time, ET);
  const company = String(row.name || symbol).trim();
  const estimate = String(row.epsForecast || '').trim();

  return makeEvent_({
    indicatorId: 'earnings_' + symbol,
    title: symbol + ' 決算発表 (' + session.label + ')',
    start: start,
    end: new Date(start.getTime() + 30 * 60000),
    impact: tickers[symbol],
    country: 'US',
    category: 'earnings',
    source: 'earnings',
    confidence: 'official',   // 取引所の決算カレンダー由来
    period: String(row.fiscalQuarterEnding || '').trim() || null,
    forecast: estimate ? 'EPS予想 ' + estimate : null,
    note: company + ' の四半期決算。\n' +
          'ナスダック100の時価総額上位銘柄の決算は、指数そのものを動かす。' +
          '特にガイダンスと設備投資計画が半導体・AI関連セクター全体に波及する。',
    url: 'https://www.nasdaq.com/market-activity/stocks/' + symbol.toLowerCase() + '/earnings',
    extra: { symbol: symbol },
  });
}

/** 複数 URL をまとめて取得する。1件ずつ待つと実行時間の上限に当たるため。 */
function fetchAllJson_(urls) {
  const requests = urls.map(function (url) {
    return { url: url, muteHttpExceptions: true, followRedirects: true,
             headers: { Accept: 'application/json' } };
  });
  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (err) {
    log_('一括取得に失敗しました: ' + err);
    return urls.map(function () { return null; });
  }
  return responses.map(function (response) {
    try {
      if (response.getResponseCode() !== 200) return null;
      return JSON.parse(response.getContentText());
    } catch (err) {
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// investing — 予想値・前回値・結果値。公式 API ではないので既定では無効。
// 数値が入る唯一の情報源だが、サイト側の変更で壊れうる。
// ---------------------------------------------------------------------------

const INVESTING_ENDPOINT =
  'https://www.investing.com/economic-calendar/Service/getCalendarFilteredData';
const INVESTING_COUNTRY_IDS = { US: 5, JP: 35, EU: 72, CN: 37, GB: 4, DE: 17 };

function providerInvesting_(ctx) {
  const countries = (CONFIG.filter.countries || []).filter(function (code) {
    return lookup_(INVESTING_COUNTRY_IDS, code, null);
  });
  const payload = [];
  (countries.length ? countries : ['US']).forEach(function (code) {
    payload.push('country%5B%5D=' + lookup_(INVESTING_COUNTRY_IDS, code, ''));
  });
  [1, 2, 3].forEach(function (level) { payload.push('importance%5B%5D=' + level); });
  payload.push('dateFrom=' + dateKey_(addDays_(ctx.start, -1)));
  payload.push('dateTo=' + dateKey_(addDays_(ctx.end, 1)));
  payload.push('timeZone=' + (CONFIG.investingTimezoneId || 55));
  payload.push('timeFilter=timeRemain');
  payload.push('currentTab=custom');
  payload.push('limit_from=0');

  const text = fetchText_(INVESTING_ENDPOINT, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: payload.join('&'),
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://www.investing.com/economic-calendar/',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
  });
  if (text === null) {
    markSourceDown_('investing', 'Investing.com に接続できませんでした');
    return [];
  }

  let fragment;
  try {
    fragment = JSON.parse(text).data || '';
  } catch (err) {
    log_('Investing.com の応答を解釈できませんでした');
    markSourceDown_('investing', '応答を解釈できませんでした');
    return [];
  }
  return investingRowsToEvents_(parseInvestingRows_(fragment), ctx);
}

/**
 * 返ってくる HTML 断片から1行ずつ値を拾う。
 * 想定外のマークアップは黙って飛ばす方針（例外にしない）。
 */
function parseInvestingRows_(html) {
  const rows = [];
  const rowRe = /<tr[^>]*data-event-datetime="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let match;
  while ((match = rowRe.exec(html)) !== null) {
    const body = match[2];
    const name = pickText_(body, /<td[^>]*class="[^"]*\bevent\b[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    if (!name) continue;
    const href = /<a[^>]+href="([^"]+)"/.exec(body);
    rows.push({
      datetime: match[1],
      name: name,
      country: investingCountry_(body),
      actual: pickText_(body, /id="eventActual_[^"]*"[^>]*>([\s\S]*?)<\/td>/),
      forecast: pickText_(body, /id="eventForecast_[^"]*"[^>]*>([\s\S]*?)<\/td>/),
      previous: pickText_(body, /id="eventPrevious_[^"]*"[^>]*>([\s\S]*?)<\/td>/),
      url: href ? 'https://www.investing.com' + href[1] : null,
    });
  }
  return rows;
}

/**
 * その行がどの国の発表か。通貨の欄（USD / EUR / CNY …）から読む。
 *
 * 名前だけで名寄せすると、「Chinese Manufacturing PMI」が米国の
 * S&P グローバル PMI に当たって、中国の数値が米指標の欄に入る。
 * 読めなかったときは null を返し、従来どおり名前だけで名寄せする
 * （マークアップが少し変わっただけで機能ごと止まらないように）。
 */
const INVESTING_CURRENCY_COUNTRY = {
  USD: 'US', JPY: 'JP', EUR: 'EU', CNY: 'CN', GBP: 'GB',
};

function investingCountry_(body) {
  const cell = pickText_(body, /<td[^>]*class="[^"]*\bflagCur\b[^"]*"[^>]*>([\s\S]*?)<\/td>/);
  if (!cell) return null;
  const code = (/\b([A-Z]{3})\b/.exec(cell.toUpperCase()) || [])[1];
  return lookup_(INVESTING_CURRENCY_COUNTRY, code, null);
}

function pickText_(html, regex) {
  const match = regex.exec(html);
  if (!match) return null;
  const text = match[1]
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text && text !== '-' ? text : null;
}

function investingRowsToEvents_(rows, ctx) {
  const assumeTz = CONFIG.investingAssumeTz || 'UTC';
  const events = [];
  rows.forEach(function (row) {
    const start = parseInvestingDate_(row.datetime, assumeTz);
    if (!start) return;
    // 名前が同じ指標があるので、発表日と国も渡して見分けてもらう。
    const indicator = matchEventName_(row.name, localDate_(start, ctx.timezone),
                                      row.country);
    if (!indicator) return;
    if (!inDisplayWindow_(start, ctx)) return;

    events.push(makeEvent_({
      indicatorId: indicator.id,
      title: indicator.name,
      start: start,
      end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
      impact: indicator.impact,
      country: indicator.country,
      category: indicator.category,
      source: 'investing',
      confidence: 'reported',   // 一次情報ではなく第三者の集計
      exactTime: true,   // サイトが実際の発表時刻を持っている
      period: investingPeriod_(row.name),
      actual: row.actual,
      forecast: row.forecast,
      previous: row.previous,
      note: indicator.why,
      url: row.url || indicator.url,
      extra: { rawName: row.name },
    }));
  });
  log_('investing: ' + events.length + ' 件');
  return events;
}

function parseInvestingDate_(text, timezone) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/.exec(String(text).trim());
  if (!match) return null;
  return zonedTime_(ymd_(+match[1], +match[2], +match[3]),
                    match[4] + ':' + match[5], timezone);
}

/** 「CPI (YoY) (Aug)」の末尾から対象期間を取り出す。 */
function investingPeriod_(name) {
  const match = /\(([A-Z][a-z]{2}(?:\/[A-Z][a-z]{2})?|Q[1-4])\)\s*$/.exec(name);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// official — 統計を出す機関そのものが公表している「発表予定表」。
//
// 発表「日」は FRED からも取れるが、FRED は時刻を持たない。
// **発表時刻が書いてあるのはこの表だけ**で、ここが唯一の一次情報になる。
// 01_indicators.js に書いてある 8:30 ET などは、ここが取れないときの
// 最後の逃げ道でしかなく、その場合は予定に「未確認の暫定値」と明記する。
//
// 相手は HTML なので、いつ形が変わってもおかしくない。FOMC 日程と同じく
// 「抽出はゆるく、採用は厳しく」で扱う。表の class や id には一切頼らず、
// 行の中から「日付に読める欄・時刻に読める欄・名前らしい欄」を拾い、
// 三つそろって初めて1行として認める。
// ---------------------------------------------------------------------------

/** 実行中に同じ URL を何度も取りに行かないための覚え書き。 */
let SCHEDULE_MEMO_ = {};

function resetScheduleMemo_() { SCHEDULE_MEMO_ = {}; }

/** 発表予定表として認めるための下限。これを割ったら丸ごと捨てる。 */
const SCHEDULE_MIN_ROWS = 3;
/**
 * 1ページから読む行数の上限。
 *
 * 年間の発表予定表はどの機関でも 300 行に届かない。桁違いに多いページが
 * 返ってきたら、それは予定表ではないか、何かが壊れている。全部なめると
 * 実行時間の上限（GAS は6分）を1情報源で食いつぶすので、頭を押さえる。
 */
const SCHEDULE_MAX_ROWS = 1000;
/** 発表時刻として現実的な範囲（現地時間）。外れたら読み間違いとみなす。 */
const SCHEDULE_MIN_HOUR = 4;
const SCHEDULE_MAX_HOUR = 22;

function providerOfficial_(ctx) {
  const sources = CONFIG.officialSchedules || [];
  if (!sources.length) return [];

  const events = [];
  let alive = 0;
  sources.forEach(function (source) {
    const rows = scheduleRowsFor_(source, ctx);
    if (rows === null) return;
    alive++;
    rows.forEach(function (row) {
      const indicator = matchScheduleRelease_(row.name);
      if (!indicator) return;
      const start = zonedTime_(row.date, row.time, source.tz || ET);
      if (!validDate_(start)) return;
      if (!inDisplayWindow_(start, ctx)) return;
      events.push(makeEvent_({
        indicatorId: indicator.id,
        title: indicator.name,
        start: start,
        end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
        impact: indicator.impact,
        country: indicator.country,
        category: indicator.category,
        source: 'official',
        confidence: 'official',    // 発表する機関そのものの予定表
        timeSource: 'official',    // 時刻も同じ表から来ている
        period: periodLabel_(row.date, indicator.period_offset || 0),
        note: indicator.why,
        url: indicator.url,
        extra: { schedule: source.name, releaseName: row.name },
      }));
    });
  });

  if (!alive) markSourceDown_('official', '発表予定表をひとつも取得できませんでした');
  log_('official: ' + events.length + ' 件');
  return events;
}

/**
 * その情報源から、同期範囲に関わる年ぶんの行を集める。
 * ひとつも取れなければ null（落ちている、と扱う）。
 */
function scheduleRowsFor_(source, ctx) {
  const years = scheduleYears_(ctx);
  let got = false;
  let rows = [];
  years.forEach(function (year) {
    const page = fetchSchedulePage_(source, year);
    if (page === null) return;
    got = true;
    rows = rows.concat(page);
  });
  return got ? rows : null;
}

/** 同期範囲がまたぐ年。年末年始は2年ぶん要る。 */
function scheduleYears_(ctx) {
  const years = [];
  for (let y = ctx.start.getUTCFullYear(); y <= ctx.end.getUTCFullYear(); y++) {
    years.push(y);
  }
  return years;
}

function fetchSchedulePage_(source, year) {
  const url = String(source.url || '').replace(/\{\{year\}\}/g, String(year));
  if (!url) return null;
  if (Object.prototype.hasOwnProperty.call(SCHEDULE_MEMO_, url)) return SCHEDULE_MEMO_[url];

  const html = fetchText_(url);
  let rows = null;
  if (html === null) {
    log_('発表予定表を取得できませんでした: ' + url);
  } else {
    const parsed = parseScheduleRows_(html, year);
    // 行がほとんど取れないのは、表の作りが変わった合図。中途半端に
    // 採ると誤った時刻が入るので、丸ごと捨てて暫定値に落とす。
    if (parsed.length < SCHEDULE_MIN_ROWS) {
      log_('発表予定表の読み取りに失敗しました（' + parsed.length + ' 行）: ' + url);
    } else {
      rows = parsed;
    }
  }
  SCHEDULE_MEMO_[url] = rows;
  return rows;
}

/**
 * 表の行から (日付・時刻・発表名) を拾う。
 *
 * class も id も見ない。どの機関の表でも、1行の中に
 * 「日付に読める欄」「時刻に読める欄」「名前らしい欄」が並ぶ、という
 * 形だけに頼る。列の順番が違っても、列が増えても動く。
 */
function parseScheduleRows_(html, defaultYear) {
  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRe.exec(html)) !== null) {
    if (rows.length >= SCHEDULE_MAX_ROWS) {
      log_('発表予定表の行が多すぎます。' + SCHEDULE_MAX_ROWS + ' 行で打ち切りました。');
      break;
    }
    const cells = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cell;
    while ((cell = cellRe.exec(match[1])) !== null) cells.push(plainText_(cell[1]));
    const row = scheduleRowFromCells_(cells, defaultYear);
    if (row) rows.push(row);
  }
  return rows;
}

function scheduleRowFromCells_(cells, defaultYear) {
  let timeIndex = -1;
  let time = null;
  for (let i = 0; i < cells.length; i++) {
    const parsed = parseScheduleTime_(cells[i]);
    if (parsed) { timeIndex = i; time = parsed; break; }
  }
  if (!time) return null;

  let dateIndex = -1;
  let date = null;
  for (let i = 0; i < cells.length; i++) {
    if (i === timeIndex) continue;
    const parsed = parseScheduleDate_(cells[i], defaultYear);
    if (parsed) { dateIndex = i; date = parsed; break; }
  }
  if (!date) return null;

  // 残りのうち、いちばん長い文字列を発表名とみなす。
  let name = '';
  for (let i = 0; i < cells.length; i++) {
    if (i === timeIndex || i === dateIndex) continue;
    if (cells[i].length > name.length) name = cells[i];
  }
  if (!/[A-Za-z]{4}/.test(name)) return null;

  return { date: date, time: time, name: name };
}

/** 「08:30 AM」「8:30 a.m.」「14:00」などを "HH:MM" にする。 */
function parseScheduleTime_(text) {
  const match = /\b(\d{1,2}):(\d{2})\s*(?:([AaPp])\.?\s*[Mm]\.?)?/.exec(String(text));
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59) return null;
  const half = match[3] ? match[3].toLowerCase() : null;
  if (half === 'p' && hour < 12) hour += 12;
  if (half === 'a' && hour === 12) hour = 0;
  if (hour > 23) return null;
  // 統計の発表が真夜中に出ることはない。外れていたら読み間違い。
  if (hour < SCHEDULE_MIN_HOUR || hour > SCHEDULE_MAX_HOUR) return null;
  return pad2_(hour) + ':' + pad2_(minute);
}

const SCHEDULE_MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * 日付欄を読む。**欄の先頭にある日付だけ**を認める。
 * 発表名の途中に出てくる数字を日付と取り違えないため。
 */
function parseScheduleDate_(text, defaultYear) {
  // 曜日が前に付く表があるので、それだけは先に落とす。
  const s = String(text).replace(/^\s*[A-Za-z]{3,9}day\s*,?\s*/i, '').trim();

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s);
  if (match) return safeYmd_(+match[1], +match[2], +match[3], defaultYear);

  match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/.exec(s);
  if (match) {
    const month = lookup_(SCHEDULE_MONTHS, match[1].slice(0, 3).toLowerCase(), 0);
    if (month) return safeYmd_(match[3] ? +match[3] : defaultYear, month, +match[2], defaultYear);
  }

  match = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(s);
  if (match) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    return safeYmd_(year, +match[1], +match[2], defaultYear);
  }
  return null;
}

/** 読み取った日付が現実的かを確かめてから Date にする。 */
function safeYmd_(year, month, day, defaultYear) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  // 表の年から大きく外れていたら読み間違い。
  if (Math.abs(year - defaultYear) > 1) return null;
  const date = ymd_(year, month, day);
  if (date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return date;
}

/**
 * 発表予定表の名前を指標に対応づける。
 *
 * 機関の発表名は FRED の release 名とほぼ同じ文字列なので、
 * すでに重なりを検査してある fred_release をそのまま使う。
 * 当たらなければ、米国の指標に限って名前の名寄せも試す。
 */
function matchScheduleRelease_(name) {
  const plain = scheduleReleaseName_(name);
  return matchFredRelease_(plain) || matchEventName_(plain, null, 'US')
      || matchFredRelease_(name) || matchEventName_(name, null, 'US');
}

const PERIOD_WORDS =
  'January|February|March|April|May|June|July|August|September|October|November|December'
  + '|First|Second|Third|Fourth|1st|2nd|3rd|4th|Q[1-4]';

/**
 * 発表名から、対象期間の部分を落とす。
 *
 * 機関の予定表は「Consumer Price Index for December 2025」のように
 * 対象月が付く。fred_release は「^Consumer Price Index$」と端を留めて
 * あるので（別の release まで巻き込まないため）、そのままでは当たらない。
 *
 * 最初に出てくる月名・四半期・西暦のところで切り、手前に残った
 * 「for」「,」「-」といったつなぎを落とす。指標名そのものに月名や
 * 西暦が入ることはないので、これで名前だけが残る。
 */
function scheduleReleaseName_(name) {
  const cut = new RegExp('\\b(?:' + PERIOD_WORDS + '|\\d{4})\\b', 'i').exec(String(name));
  const head = cut ? String(name).slice(0, cut.index) : String(name);
  return head
    .replace(/[\s,;:\u2013\u2014-]+$/, '')
    .replace(/\s+(?:for|in|of)$/i, '')
    .replace(/[\s,;:\u2013\u2014-]+$/, '')
    .replace(/\s*\($/, '')
    .trim();
}

/** タグと実体参照を落として、素のテキストにする。 */
function plainText_(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, function (_, code) { return String.fromCharCode(Number(code)); })
    .replace(/\s+/g, ' ')
    .trim();
}
