/**
 * 各情報源の突き合わせと、ナスダック影響度による選抜。
 */

/** 推定日と確定日がこの日数以内なら「同じ発表」とみなし、推定側を捨てる。 */
const SUPERSEDE_WINDOW_DAYS = 12;

/**
 * 同期範囲の上限。設定を書き間違えて 9999 などにすると、何十年ぶんもの
 * 発表日を展開しようとして実行時間の上限に当たり、毎回失敗するようになる。
 * 設定の検証でも弾いているが、ここでも頭を押さえておく。
 */
const MAX_WINDOW_DAYS = 400;

function syncWindow_(today) {
  const base = today || localDate_(new Date(), CONFIG.timezone);
  const config = CONFIG.window || {};
  const ahead = clampDays_(config.daysAhead, 60, 'window.daysAhead');
  const back = clampDays_(config.daysBack, 5, 'window.daysBack');
  return {
    start: addDays_(base, -back),
    end: addDays_(base, ahead),
    timezone: CONFIG.timezone,
  };
}

function clampDays_(value, fallback, label) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) return fallback;
  if (value > MAX_WINDOW_DAYS) {
    log_(label + ' が大きすぎるため ' + MAX_WINDOW_DAYS + ' 日に抑えました: ' + value);
    return MAX_WINDOW_DAYS;
  }
  return Math.floor(value);
}

/**
 * 有効な情報源すべてから集めて、重複を解消し、条件で絞る。
 * ひとつの情報源が落ちても同期全体は止めない。
 */
function collectEvents_(ctx) {
  const providers = [];
  if (CONFIG.providers.rules) providers.push({ name: 'rules', run: providerRules_ });
  if (CONFIG.providers.fomc) providers.push({ name: 'fomc', run: providerFomc_ });
  if (CONFIG.providers.market) providers.push({ name: 'market', run: providerMarket_ });
  if (CONFIG.providers.fred) providers.push({ name: 'fred', run: providerFred_ });
  if (CONFIG.providers.earnings) providers.push({ name: 'earnings', run: providerEarnings_ });
  if (CONFIG.providers.investing) providers.push({ name: 'investing', run: providerInvesting_ });

  let raw = [];
  providers.forEach(function (provider) {
    let found;
    try {
      found = provider.run(ctx) || [];
    } catch (err) {
      log_('情報源 ' + provider.name + ' でエラー（スキップします）: ' + err);
      return;
    }
    log_(provider.name + ': ' + found.length + ' 件');
    raw = raw.concat(found);
  });

  const merged = dropSupersededEstimates_(mergeEvents_(raw, ctx.timezone), ctx.timezone);
  const selected = applyFilter_(merged);
  return selected.sort(function (a, b) {
    if (a.start.getTime() !== b.start.getTime()) return a.start - b.start;
    if (a.impact !== b.impact) return b.impact - a.impact;
    return a.indicatorId < b.indicatorId ? -1 : 1;
  });
}

/** 同じ発表を同じ日に報告しているものをひとつにまとめる。 */
function mergeEvents_(events, timezone) {
  const byUid = {};
  events.forEach(function (event) {
    const uid = eventUid_(event, timezone);
    byUid[uid] = byUid[uid] ? mergeEvent_(byUid[uid], event) : event;
  });
  return Object.keys(byUid).map(function (uid) { return byUid[uid]; });
}

/**
 * 確定日が出たら、その近くにある推定日を捨てる。
 *
 * ルール計算は CPI を12日に置き、FRED は11日だと言う。同じ発表なのに
 * 日が違うので mergeEvents_ では別物として残ってしまう。ここで消さないと
 * カレンダーに重複が出る。
 */
function dropSupersededEstimates_(events, timezone) {
  const confirmed = {};
  events.forEach(function (event) {
    if (event.estimated) return;
    const key = event.indicatorId;
    (confirmed[key] = confirmed[key] || []).push(localDate_(event.start, timezone));
  });

  return events.filter(function (event) {
    if (!event.estimated) return true;
    const known = confirmed[event.indicatorId] || [];
    const day = localDate_(event.start, timezone);
    for (let i = 0; i < known.length; i++) {
      if (Math.abs(daysBetween_(day, known[i])) <= SUPERSEDE_WINDOW_DAYS) return false;
    }
    return true;
  });
}

/** ナスダック影響度その他の条件で選抜する。 */
function applyFilter_(events) {
  const filter = CONFIG.filter || {};
  // 設定を消してしまったときに「全部消える」のが一番まずいので、
  // しきい値が読めなければ既定値に落とす。
  const minImpact = typeof filter.minImpact === 'number' ? filter.minImpact : 55;
  const include = filter.include || [];
  const exclude = filter.exclude || [];
  const countries = filter.countries || [];
  const categories = filter.categories || [];

  return events.filter(function (event) {
    if (exclude.indexOf(event.indicatorId) !== -1) return false;
    if (include.indexOf(event.indicatorId) !== -1) return true;
    if (countries.length && countries.indexOf(event.country) === -1) return false;
    if (categories.length && categories.indexOf(event.category) === -1) return false;
    return event.impact >= minImpact;
  });
}
