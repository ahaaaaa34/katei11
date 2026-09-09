/**
 * 各情報源の突き合わせと、ナスダック影響度による選抜。
 */

/** 推定日と確定日がこの日数以内なら「同じ発表」とみなし、推定側を捨てる。 */
const SUPERSEDE_WINDOW_DAYS = 12;

function syncWindow_(today) {
  const base = today || localDate_(new Date(), CONFIG.timezone);
  return {
    start: addDays_(base, -(CONFIG.window.daysBack || 0)),
    end: addDays_(base, CONFIG.window.daysAhead || 60),
    timezone: CONFIG.timezone,
  };
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
  const filter = CONFIG.filter;
  const include = filter.include || [];
  const exclude = filter.exclude || [];
  const countries = filter.countries || [];
  const categories = filter.categories || [];

  return events.filter(function (event) {
    if (exclude.indexOf(event.indicatorId) !== -1) return false;
    if (include.indexOf(event.indicatorId) !== -1) return true;
    if (countries.length && countries.indexOf(event.country) === -1) return false;
    if (categories.length && categories.indexOf(event.category) === -1) return false;
    return event.impact >= filter.minImpact;
  });
}
