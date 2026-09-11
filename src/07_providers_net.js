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
    const name = row.release_name || '';
    if (!name) return;
    const indicator = matchFredRelease_(name);
    if (!indicator) return;
    const day = parseDateKey_(row.date);
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
    return INVESTING_COUNTRY_IDS[code];
  });
  const payload = [];
  (countries.length ? countries : ['US']).forEach(function (code) {
    payload.push('country%5B%5D=' + INVESTING_COUNTRY_IDS[code]);
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
  return (code && INVESTING_CURRENCY_COUNTRY[code]) || null;
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
