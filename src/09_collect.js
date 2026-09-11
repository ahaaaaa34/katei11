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

// ---------------------------------------------------------------------------
// 情報源の生死
//
// 「今回は出てこなかった」には2つの意味がある。本当に無くなった（発表日が
// 動いた・しきい値を上げた）のと、その情報源に今回つながらなかっただけ、の
// 2つ。後者を消してしまうと、通信が不調な日だけカレンダーから決算や CPI が
// 消える。区別できるように、落ちた情報源をここに控えておく。
// ---------------------------------------------------------------------------

let SOURCE_DOWN_ = {};

function resetSourceHealth_() { SOURCE_DOWN_ = {}; }

function markSourceDown_(name, why) {
  if (!Object.prototype.hasOwnProperty.call(SOURCE_DOWN_, name)) {
    log_('情報源 ' + name + ' は今回使えませんでした（既存の予定は残します）'
         + (why ? ': ' + why : ''));
  }
  SOURCE_DOWN_[name] = why || '取得できませんでした';
}

function sourceIsDown_(name) {
  return Object.prototype.hasOwnProperty.call(SOURCE_DOWN_, name || '');
}

/** 今回落ちていた情報源の名前（実行結果の報告に使う）。 */
function downSources_() { return Object.keys(SOURCE_DOWN_); }

/**
 * 有効な情報源すべてから集めて、重複を解消し、条件で絞る。
 * ひとつの情報源が落ちても同期全体は止めない。
 */
function collectEvents_(ctx) {
  resetSourceHealth_();
  resetScheduleMemo_();
  const providers = [];
  if (CONFIG.providers.rules) providers.push({ name: 'rules', run: providerRules_ });
  if (CONFIG.providers.fomc) providers.push({ name: 'fomc', run: providerFomc_ });
  if (CONFIG.providers.market) providers.push({ name: 'market', run: providerMarket_ });
  // 発表機関の予定表が先。時刻を持つ唯一の一次情報なので、
  // 他が同じ発表を持ってきても時刻はこちらが勝つ。
  if (CONFIG.providers.officialTimes) {
    providers.push({ name: 'official', run: providerOfficial_ });
  }
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
      markSourceDown_(provider.name, String(err));
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

/**
 * 同じ発表を報告しているものをひとつにまとめる。
 *
 * まとめる基準は2段構え。
 *
 *  1. **指標の地元の日付**（米 CPI なら米東部の 1/11）。
 *     情報源によって発表時刻の申告が少し違う（FRED＋カタログは 8:30 ET、
 *     集計サイトは 7:45 ET など）と、表示タイムゾーンによっては真夜中を
 *     またいで「別の日の別の発表」に見えてしまう。実際に起きた例：
 *     シドニー表示だと 1/11 12:45Z が 1/11、1/11 13:30Z が 1/12 になり、
 *     同じ CPI がカレンダーに2つ並んだ。地元の日付なら、どちらも 1/11。
 *
 *  2. **表示日**。予定 ID は表示日から決まるので、ここが重なったままだと
 *     同じ ID の予定を2つ作ろうとして、片方が黙って消える。
 */
function mergeEvents_(events, timezone) {
  const byRelease = groupMerge_(events, function (event) {
    return releaseKey_(event, timezone);
  });
  return groupMerge_(byRelease, function (event) {
    return eventUid_(event, timezone);
  });
}

/** 同じ鍵になったものを mergeEvent_ でまとめる（最初に現れた順は保つ）。 */
function groupMerge_(events, keyOf) {
  const byKey = {};
  const order = [];
  events.forEach(function (event) {
    const key = keyOf(event);
    if (Object.prototype.hasOwnProperty.call(byKey, key)) {
      byKey[key] = mergeEvent_(byKey[key], event);
      return;
    }
    byKey[key] = event;
    order.push(key);
  });
  return order.map(function (key) { return byKey[key]; });
}

/**
 * 「どの発表か」を表す鍵。指標の地元のタイムゾーンで日付を取る。
 *
 * 終日の予定（休場日など）は、表示タイムゾーンのその日そのものが中身なので
 * 地元の日付に直すとかえってずれる。表示日で見る。
 */
function releaseKey_(event, timezone) {
  if (event.allDay) return eventUid_(event, timezone);
  const indicator = indicator_(event.indicatorId);
  const tz = indicator ? indicatorTimezone_(indicator) : ET;
  return event.indicatorId + '@' + dateKey_(localDate_(event.start, tz));
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
    if (isEstimated_(event)) return;
    const key = event.indicatorId;
    (confirmed[key] = confirmed[key] || []).push(localDate_(event.start, timezone));
  });

  return events.filter(function (event) {
    if (!isEstimated_(event)) return true;
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
