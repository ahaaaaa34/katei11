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

function providerFred_(ctx) {
  const apiKey = prop_(PROP_FRED_KEY);
  if (!apiKey) {
    log_('FRED: API キー未設定のためスキップ（スクリプト プロパティ ' + PROP_FRED_KEY + '）');
    return [];
  }

  const rows = fredReleaseDates_(apiKey, ctx.start, ctx.end);
  if (rows === null) return [];

  const events = [];
  rows.forEach(function (row) {
    const name = row.release_name || '';
    if (!name) return;
    const indicator = matchFredRelease_(name);
    if (!indicator) return;
    const day = parseDateKey_(row.date);
    if (day.getTime() < ctx.start.getTime() || day.getTime() > ctx.end.getTime()) return;

    const start = zonedTime_(day, indicator.time, indicatorTimezone_(indicator));
    events.push(makeEvent_({
      indicatorId: indicator.id,
      title: indicator.name,
      start: start,
      end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
      impact: indicator.impact,
      country: indicator.country,
      category: indicator.category,
      source: 'fred',
      estimated: false,
      period: periodLabel_(day, indicator.period_offset || 0),
      note: indicator.why,
      url: indicator.url,
      extra: { fredRelease: name },
    }));
  });
  log_('FRED: ' + rows.length + ' 件中 ' + events.length + ' 件が該当');
  return events;
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
    const page = payload.release_dates || [];
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

  const days = [];
  for (let day = ctx.start; day.getTime() <= ctx.end.getTime(); day = addDays_(day, 1)) {
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
      if (payload === null) { failures++; return; }
      const rows = (payload.data && payload.data.rows) || [];
      rows.forEach(function (row) {
        const event = earningsEvent_(chunk[index], row, tickers);
        if (event) events.push(event);
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
    estimated: row.time === 'time-not-supplied',
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
    return INVESTING_COUNTRY_IDS[code];
  });
  const payload = [];
  (countries.length ? countries : ['US']).forEach(function (code) {
    payload.push('country%5B%5D=' + INVESTING_COUNTRY_IDS[code]);
  });
  [1, 2, 3].forEach(function (level) { payload.push('importance%5B%5D=' + level); });
  payload.push('dateFrom=' + dateKey_(ctx.start));
  payload.push('dateTo=' + dateKey_(ctx.end));
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
  if (text === null) return [];

  let fragment;
  try {
    fragment = JSON.parse(text).data || '';
  } catch (err) {
    log_('Investing.com の応答を解釈できませんでした');
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
      actual: pickText_(body, /id="eventActual_[^"]*"[^>]*>([\s\S]*?)<\/td>/),
      forecast: pickText_(body, /id="eventForecast_[^"]*"[^>]*>([\s\S]*?)<\/td>/),
      previous: pickText_(body, /id="eventPrevious_[^"]*"[^>]*>([\s\S]*?)<\/td>/),
      url: href ? 'https://www.investing.com' + href[1] : null,
    });
  }
  return rows;
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
    const indicator = matchEventName_(row.name);
    if (!indicator) return;
    const start = parseInvestingDate_(row.datetime, assumeTz);
    if (!start) return;
    const day = localDate_(start, ctx.timezone);
    if (day.getTime() < ctx.start.getTime() || day.getTime() > ctx.end.getTime()) return;

    events.push(makeEvent_({
      indicatorId: indicator.id,
      title: indicator.name,
      start: start,
      end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
      impact: indicator.impact,
      country: indicator.country,
      category: indicator.category,
      source: 'investing',
      estimated: false,
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
