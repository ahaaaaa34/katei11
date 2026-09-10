/**
 * 指標カタログの照会。
 *
 * 外部の情報源はイベント名が自由文字列なので、カタログ側の正規表現で
 * 指標 id に名寄せする。長いパターンを先に試すことで "core cpi" が
 * 素の "cpi" より優先される。
 */

let CATALOG_CACHE_ = null;

function catalog_() {
  if (CATALOG_CACHE_) return CATALOG_CACHE_;
  const byId = {};
  const matchers = [];
  const fredMatchers = [];

  INDICATORS.forEach(function (indicator) {
    byId[indicator.id] = indicator;
    (indicator.match || []).forEach(function (pattern) {
      matchers.push({ re: new RegExp(pattern, 'i'), indicator: indicator, len: pattern.length });
    });
    if (indicator.fred_release) {
      fredMatchers.push({ re: new RegExp(indicator.fred_release, 'i'), indicator: indicator });
    }
  });
  matchers.sort(function (a, b) { return b.len - a.len; });

  CATALOG_CACHE_ = { byId: byId, matchers: matchers, fredMatchers: fredMatchers };
  return CATALOG_CACHE_;
}

function indicator_(id) {
  return catalog_().byId[id] || null;
}

function indicatorsWithRules_() {
  return INDICATORS.filter(function (indicator) {
    return indicator.schedule && indicator.schedule.type && indicator.schedule.type !== 'none';
  });
}

function matchEventName_(name) {
  const matchers = catalog_().matchers;
  for (let i = 0; i < matchers.length; i++) {
    if (matchers[i].re.test(name)) return matchers[i].indicator;
  }
  return null;
}

function matchFredRelease_(name) {
  const matchers = catalog_().fredMatchers;
  for (let i = 0; i < matchers.length; i++) {
    if (matchers[i].re.test(name)) return matchers[i].indicator;
  }
  return null;
}

function indicatorTimezone_(indicator) {
  return indicator.tz || ET;
}

function ruleIsExact_(indicator) {
  return !!(indicator.schedule && indicator.schedule.exact);
}

/** 発表月から対象期間のラベル（「2026年8月分」）を作る。 */
function periodLabel_(date, offset) {
  if (!offset) return null;
  const index = date.getUTCMonth() + offset;
  const year = date.getUTCFullYear() + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12 + 1;
  return year + '年' + month + '月分';
}

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------

const TIERS = ['S', 'A', 'B', 'C'];

/** 情報源の優先順位。数字が大きいほど、衝突したときに勝つ。 */
const SOURCE_PRIORITY = {
  rules: 10,
  market: 20,
  fomc: 30,
  earnings: 40,
  // investing は予想・結果の数値を持つ唯一の情報源だが、日付の確度は公式
  // カレンダーである FRED に劣るので一段下に置く。mergeEvents_ が
  // 「日時は上位・空欄の値は下位から」で合成するのでこれで両取りになる。
  investing: 50,
  fred: 60,
  digest: 70,
};

function tierFor_(impact) {
  if (impact >= 90) return 'S';
  if (impact >= 75) return 'A';
  if (impact >= 55) return 'B';
  return 'C';
}

function makeEvent_(fields) {
  const event = {
    indicatorId: fields.indicatorId,
    title: fields.title,
    start: fields.start,
    end: fields.end,
    impact: Math.max(0, Math.min(100, fields.impact | 0)),
    country: fields.country || 'US',
    category: fields.category || 'other',
    source: fields.source || 'rules',
    allDay: !!fields.allDay,
    estimated: !!fields.estimated,
    // その情報源が「実際の発表時刻」を持っているか。
    // false のものはカタログの慣例値（8:30 ET など）を当てているだけなので、
    // 本物の時刻を持つ情報源が現れたらそちらに譲る。
    exactTime: !!fields.exactTime,
    period: fields.period || null,
    actual: fields.actual || null,
    forecast: fields.forecast || null,
    previous: fields.previous || null,
    note: fields.note || '',
    url: fields.url || null,
    extra: fields.extra || {},
  };
  if (!(event.start instanceof Date) || !(event.end instanceof Date)) {
    throw new Error(event.indicatorId + ': start/end は Date である必要があります');
  }
  if (event.end.getTime() < event.start.getTime()) {
    throw new Error(event.indicatorId + ': end が start より前です');
  }
  return event;
}

function eventTier_(event) {
  return tierFor_(event.impact);
}

/**
 * そのイベントが同期範囲に入るか。
 *
 * 判定は必ず「表示タイムゾーンでの日付」で行う。予定 ID も一覧取得の範囲も
 * 表示タイムゾーン基準なので、生成側だけ米東部の日付で判定すると、窓の端の
 * イベントが一覧に出てこず、毎回作り直しになる。
 */
function inDisplayWindow_(instant, ctx) {
  const day = localDate_(instant, ctx.timezone);
  return day.getTime() >= ctx.start.getTime() && day.getTime() <= ctx.end.getTime();
}

/** 表示日基準の同一性。1指標・1日でひとつ。 */
function eventUid_(event, timezone) {
  return event.indicatorId + '@' + dateKey_(localDate_(event.start, timezone));
}

/** カレンダーの予定 ID。base32hex（0-9a-v）しか使えない制約に合わせる。 */
function eventCalendarId_(event, timezone) {
  return 'ec' + base32hex_(sha1Bytes_(eventUid_(event, timezone)));
}

/** 表示に使う値だけのハッシュ。変化がなければ API を叩かないために使う。 */
function eventContentHash_(event) {
  const payload = [
    event.title, event.start.toISOString(), event.end.toISOString(), event.impact,
    event.allDay, event.estimated, event.period, event.actual, event.forecast,
    event.previous, event.note, event.url, event.source,
  ].join('|');
  return sha1Hex_(payload).slice(0, 16);
}

/**
 * 同じ発表についての2つの報告を合成する。
 * 上位の情報源が日時と同一性を決め、下位は「上位が持っていない値」だけを埋める。
 */
function mergeEvent_(a, b) {
  let high = a, low = b;
  if ((SOURCE_PRIORITY[b.source] || 0) > (SOURCE_PRIORITY[a.source] || 0)) {
    high = b; low = a;
  }
  const merged = Object.assign({}, high);
  ['actual', 'forecast', 'previous', 'period', 'url'].forEach(function (name) {
    if (!merged[name] && low[name]) merged[name] = low[name];
  });
  if (!merged.note && low.note) merged.note = low.note;
  // 確定日は、どの情報源から来たものでも推定日に勝つ。
  if (merged.estimated && !low.estimated) {
    merged.estimated = false;
    merged.start = low.start;
    merged.end = low.end;
  }
  // 時刻も同じ考え方で、本物を持っている方に譲る。
  // 例: FRED は発表「日」しか返さないので時刻はカタログの慣例値になる。
  // そこに実時刻を持つ情報源が来たら、日付は FRED、時刻はそちらを採る。
  // （合成は同じ表示日のもの同士でしか起きないので、日付はずれない）
  if (!merged.exactTime && low.exactTime) {
    merged.exactTime = true;
    merged.start = low.start;
    merged.end = low.end;
  }
  merged.extra = Object.assign({}, low.extra, high.extra);
  return merged;
}
