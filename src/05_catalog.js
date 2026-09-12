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

/**
 * 外部のイベント名を指標に名寄せする。
 *
 * 取り違えると、他の指標の数値がカレンダーに入る。迷ったら「当てない」側に倒す。
 *
 * country が分かっているときは、**違う国の指標には絶対に当てない**。
 * 「Chinese Manufacturing PMI」が米国の S&P グローバル PMI に当たって
 * 中国の数値が米指標の欄に入る、という取り違えが実際に起きていた。
 *
 * 複数の候補が残ったときの決め方は、具体性 → 発表日の近さ、の順。
 *  - 具体性: 当たったパターンが長い方。「ism manufacturing pmi」は
 *    「manufacturing pmi」より具体的で、名前だけで決着がつく。
 *  - 発表日: ミシガン大の速報値と確報値のようにパターンが同じものは、
 *    発表規則が予想する日に近い方を採る。速報は第2金曜、確報は最終金曜。
 *
 * @param {string} name     外部サイトのイベント名
 * @param {Date=} date      その発表の日付（UTC深夜）。あれば判別に使う
 * @param {string=} country その行の国コード。あれば他国の指標を除外する
 */
function matchEventName_(name, date, country) {
  const matchers = catalog_().matchers;
  const hits = [];
  const seen = {};
  for (let i = 0; i < matchers.length; i++) {
    if (!matchers[i].re.test(name)) continue;
    const indicator = matchers[i].indicator;
    const length = matchers[i].len;
    if (seen[indicator.id] !== undefined) {
      // 同じ指標の別のパターンが当たったら、具体的な方を覚えておく。
      hits[seen[indicator.id]].length = Math.max(hits[seen[indicator.id]].length, length);
      continue;
    }
    seen[indicator.id] = hits.length;
    hits.push({ indicator: indicator, length: length });
  }
  if (!hits.length) return null;

  const pool = country
    ? hits.filter(function (hit) { return hit.indicator.country === country; })
    : hits;
  // 国が分かっていて、その国の指標がひとつも当たらないなら当てない。
  if (!pool.length) return null;
  if (pool.length === 1) return pool[0].indicator;

  let widest = 0;
  pool.forEach(function (hit) { widest = Math.max(widest, hit.length); });
  const specific = pool.filter(function (hit) { return hit.length === widest; });
  if (specific.length === 1 || !date) return specific[0].indicator;

  let best = null;
  let bestGap = Infinity;
  specific.forEach(function (hit) {
    const gap = ruleDistanceDays_(hit.indicator, date);
    if (gap !== null && gap < bestGap) {
      bestGap = gap;
      best = hit.indicator;
    }
  });
  return best || specific[0].indicator;
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

/**
 * その予定の「日付の根拠」。カレンダーに嘘を書かないための型。
 *
 *   official  一次情報源が公表した日程そのもの
 *             （FRED の発表日、Fed 公式ページの会合日程、Nasdaq の決算日）
 *   reported  第三者が集計したもの（Investing.com）。実務上は正確だが一次ではない
 *   rule      確定的な発表規則からの算出
 *             （ISM＝第1営業日、失業保険＝毎週木曜、取引所の休場ルールなど）
 *   estimated 概算、または人が書いたまま公式と照合していないもの
 *
 * 数字が大きいほど確か。合成のときはこの順で日付を採る。
 */
const CONFIDENCE_RANK = { official: 4, reported: 3, rule: 2, estimated: 1 };
const CONFIDENCE_LABEL = {
  official: '公式発表の日程',
  reported: '集計サイトの日程',
  rule: '発表規則から算出',
  estimated: '概算（未確定）',
};

/**
 * 型の名前として認めるか。
 *
 * `CONFIDENCE_RANK[name]` をそのまま見ると、name が '__proto__' や
 * 'toString' のときに Object の中身が返ってきて、型外の値が真として
 * 通ってしまう。カレンダーに「日付の根拠 toString」と出かねないので、
 * 自分で持っている鍵かどうかで判定する。
 */
function confidenceRank_(name) {
  return lookup_(CONFIDENCE_RANK, name, 0);
}

/**
 * 「発表時刻がどこから来たか」。日付の根拠とは別の軸で持つ。
 *
 *   official  統計を出す機関の発表予定表そのもの（BLS・BEA・センサス局）
 *   reported  第三者の集計サイトが載せている実績時刻
 *   fallback  01_indicators.js に書いてある暫定値。一次資料と突き合わせて
 *             いないので、確かめられていない値として扱う
 *
 * 確かめていない時刻を、確かめた時刻のように見せないために型で持つ。
 */
const TIME_RANK = { official: 3, reported: 2, fallback: 1 };
const TIME_LABEL = {
  official: '発表機関の予定表',
  reported: '集計サイトの実績時刻',
  fallback: '未確認の暫定値',
};

function timeRank_(name) {
  return lookup_(TIME_RANK, name, 0);
}

/** 件名に「未確定」と出すのはこれだけ。 */
function isEstimated_(event) {
  return event.confidence === 'estimated';
}

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
  // 発表する機関そのものの予定表。日付も時刻もここが最上位。
  official: 65,
  digest: 70,
};

function tierFor_(impact) {
  if (impact >= 90) return 'S';
  if (impact >= 75) return 'A';
  if (impact >= 55) return 'B';
  return 'C';
}

/**
 * 外から来た文字列の長さの上限。
 *
 * Google が受け取れるのは件名 1024 文字・説明 8192 文字まで。
 * 取得先のマークアップが変わって「値」の欄がページの残り全部を
 * 飲み込むと、そのまま件名に入って**同期そのものが失敗する**。
 * 1件の読み取り事故で全部止まらないよう、入口で切っておく。
 */
const MAX_TITLE_CHARS = 200;
const MAX_FIGURE_CHARS = 40;
const MAX_NOTE_CHARS = 3000;
const MAX_PERIOD_CHARS = 60;

/**
 * 「値」として受け取ってよい形か。
 *
 * 予想値・前回値・結果値は、取得先の欄をそのまま読んでいる。そこは
 * カレンダーの**件名に出る**ので、先方が壊れたり乗っ取られたりすると、
 * 利用者の予定表に任意の文章やリンクを置けてしまう。
 * 数字・記号・単位だけを通し、それ以外は値が無かったものとして扱う。
 *
 *   通す   0.2% / -0.1% / 215K / 1.5M / $1.20 / 1,234 / 49.5 / 3.25pts
 *   通さない  当選！ https://… / 口座番号を入力してください / <a href=…>
 */
const FIGURE_SHAPE =
  /^[<>≈~]?\s*[-+\u2212]?\s*[¥$€£]?\s*\d[\d,]*(\.\d+)?\s*(%|K|M|B|T|bp|bps|pt|pts)?$/i;

function figureOrNull_(text) {
  if (text === null || text === undefined) return null;
  const value = String(text).trim();
  if (!value) return null;
  return FIGURE_SHAPE.test(value) ? value : null;
}

function clip_(text, limit) {
  if (text === null || text === undefined) return null;
  const s = String(text);
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…';
}

function makeEvent_(fields) {
  const event = {
    indicatorId: fields.indicatorId,
    title: clip_(fields.title, MAX_TITLE_CHARS),
    start: fields.start,
    end: fields.end,
    impact: Math.max(0, Math.min(100, fields.impact | 0)),
    country: fields.country || 'US',
    category: fields.category || 'other',
    source: fields.source || 'rules',
    allDay: !!fields.allDay,
    // 日付の根拠。指定が無いものは「概算」に倒す（過大に言わないため）。
    confidence: hasKey_(CONFIDENCE_RANK, fields.confidence) ? fields.confidence : 'estimated',
    // 発表時刻の出どころ。指定が無ければ、外から時刻を持ってきたかどうかで
    // 決める（exactTime だけを渡す古い呼び方との互換のため）。
    timeSource: hasKey_(TIME_RANK, fields.timeSource) ? fields.timeSource
      : (fields.exactTime ? 'reported' : 'fallback'),
    period: fields.period ? clip_(fields.period, MAX_PERIOD_CHARS) : null,
    // 値は「値の形」をしているものだけ。件名に出る場所なので、
    // 取得先が壊れても任意の文章が載らないようにする。
    actual: figureOrNull_(clip_(fields.actual, MAX_FIGURE_CHARS)),
    forecast: figureOrNull_(clip_(fields.forecast, MAX_FIGURE_CHARS)),
    previous: figureOrNull_(clip_(fields.previous, MAX_FIGURE_CHARS)),
    note: fields.note ? clip_(fields.note, MAX_NOTE_CHARS) : '',
    url: fields.url || null,
    extra: fields.extra || {},
  };
  // 「暫定値ではない」＝カタログの時刻をそのまま当てたのではない、という意味。
  event.exactTime = event.timeSource !== 'fallback';
  if (!validDate_(event.start) || !validDate_(event.end)) {
    // 読めない日付のまま進むと、カレンダーにでたらめな日時が入る。
    // 取得先が壊れた値を返したときは、その行を飛ばすのが情報源側の責任。
    throw new Error(event.indicatorId + ': start/end は妥当な Date である必要があります');
  }
  if (event.end.getTime() < event.start.getTime()) {
    throw new Error(event.indicatorId + ': end が start より前です');
  }
  return event;
}

/** Date として読める値か（Invalid Date も instanceof Date を通ってしまう）。 */
function validDate_(value) {
  return value instanceof Date && !isNaN(value.getTime());
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
    event.allDay, event.confidence, event.period, event.actual, event.forecast,
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
  if (lookup_(SOURCE_PRIORITY, b.source, 0) > lookup_(SOURCE_PRIORITY, a.source, 0)) {
    high = b; low = a;
  }
  const merged = Object.assign({}, high);
  ['actual', 'forecast', 'previous', 'period', 'url'].forEach(function (name) {
    if (!merged[name] && low[name]) merged[name] = low[name];
  });
  if (!merged.note && low.note) merged.note = low.note;
  // 日付は、根拠の確かな方を採る。情報源の優先順位とは別の軸で決める。
  // 例: ルール計算(rule)より FRED の公式日(official)が勝つ。
  if (confidenceRank_(low.confidence) > confidenceRank_(merged.confidence)) {
    merged.confidence = low.confidence;
    merged.start = low.start;
    merged.end = low.end;
  }
  // 時刻も同じ考え方で、出どころの確かな方に譲る。
  // 例: FRED は発表「日」しか返さないので時刻は暫定値になる。そこへ
  // 発表機関の予定表（official）や集計サイト（reported）が来たら、
  // 日付は FRED、時刻はそちらを採る。
  // （合成は同じ発表どうしでしか起きないので、日付はずれない）
  if (timeRank_(low.timeSource) > timeRank_(merged.timeSource)) {
    merged.timeSource = low.timeSource;
    merged.exactTime = low.exactTime;
    merged.start = low.start;
    merged.end = low.end;
  }
  merged.extra = Object.assign({}, low.extra, high.extra);
  return merged;
}
