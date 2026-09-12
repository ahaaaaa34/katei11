/**
 * 件名と説明文の組み立て。
 */

const TIER_EMOJI = { S: '🔴', A: '🟠', B: '🟡', C: '⚪' };
const TIER_LABEL = { S: '最重要', A: '重要', B: '注目', C: '参考' };
const FLAGS = { US: '🇺🇸', JP: '🇯🇵', EU: '🇪🇺', CN: '🇨🇳', GB: '🇬🇧', DE: '🇩🇪' };
const MARKER = 'econ-calendar';

const CATEGORY_LABEL = {
  fed: '金融政策', inflation: '物価', labor: '雇用', growth: '景気',
  sentiment: '景況感', housing: '住宅', trade: '貿易', rates: '金利・債券',
  market: '市場イベント', earnings: '決算', other: 'その他',
};

function stars_(impact) {
  const filled = Math.max(1, Math.min(5, Math.round(impact / 20)));
  return new Array(filled + 1).join('★') + new Array(5 - filled + 1).join('☆');
}

function renderTitle_(event) {
  const parts = [];
  const tier = eventTier_(event);
  if (CONFIG.display.impactEmoji) parts.push(lookup_(TIER_EMOJI, tier, ''));
  const flag = lookup_(FLAGS, event.country, '');
  if (CONFIG.display.countryFlag && flag) parts.push(flag);
  parts.push(event.title);
  if (CONFIG.display.showScore) parts.push('[' + event.impact + ']');
  if (event.actual) parts.push('→ ' + event.actual);
  else if (isEstimated_(event)) parts.push('(予定日未確定)');
  return parts.join(' ');
}

function formatClock_(instant, timezone) {
  const parts = tzParts_(instant, timezone);
  const date = ymd_(parts.year, parts.month, parts.day);
  return {
    date: parts.year + '/' + pad2_(parts.month) + '/' + pad2_(parts.day),
    time: pad2_(parts.hour) + ':' + pad2_(parts.minute),
    weekday: WEEKDAY_JA[weekdayOf_(date)],
    short: pad2_(parts.month) + '/' + pad2_(parts.day),
  };
}

function renderDescription_(event) {
  // 週次まとめは指標ではないので、影響度や日付の根拠を並べても意味がない。
  if (isDigest_(event)) return renderDigestDescription_(event);
  const tier = eventTier_(event);
  const local = formatClock_(event.start, CONFIG.timezone);
  const lines = [];

  lines.push('影響度  ' + stars_(event.impact) + '  ' + event.impact + '/100 '
             + '（' + tier + 'ランク・' + lookup_(TIER_LABEL, tier, tier) + '）');
  lines.push('分類    ' + lookup_(CATEGORY_LABEL, event.category, event.category));
  if (event.allDay || CONFIG.display.allDay) {
    // 米東部時間の午後に出るもの（FOMC など）は日本時間だと翌日になる。
    // どちらの日付を指しているのか分かるよう、ずれるときだけ併記する。
    const eastern = formatClock_(event.start, ET);
    const shifted = eastern.date !== local.date && !event.allDay
      ? '   （米国時間 ' + eastern.date + ' の発表）' : '';
    lines.push('日付    ' + local.date + '(' + local.weekday + ')' + shifted);
  } else {
    const eastern = formatClock_(event.start, ET);
    lines.push('日時    ' + local.date + '(' + local.weekday + ') ' + local.time
               + '  (現地 ' + eastern.time + ' ET)');
  }
  if (event.period) lines.push('対象期間 ' + event.period);
  // 「この日付はどこから来たのか」を必ず書く。カレンダーを見た人が、
  // どこまで信じてよいかを判断できるようにするため。
  lines.push('日付の根拠 '
             + lookup_(CONFIDENCE_LABEL, event.confidence, event.confidence));
  if (!event.allDay && !CONFIG.display.allDay) {
    lines.push('時刻の根拠 '
               + lookup_(TIME_LABEL, event.timeSource, event.timeSource));
  }

  const figures = [['予想', event.forecast], ['前回', event.previous], ['結果', event.actual]]
    .filter(function (pair) { return !!pair[1]; });
  if (figures.length) {
    lines.push('');
    figures.forEach(function (pair) { lines.push('　' + pair[0] + '  ' + pair[1]); });
  }

  if (event.note) {
    lines.push('');
    lines.push('── ナスダックへの効き方 ──');
    lines.push(String(event.note).trim());
  }

  lines.push('');
  if (isEstimated_(event)) lines.push('⚠️ ' + estimatedNote_(event));
  if (event.url) lines.push('🔗 ' + event.url);
  // どのモジュールが勝ったかは書かない。情報源が一時的に落ちて別の経路から
  // 同じ予定が組み立てられただけで説明文が変わり、更新が走ってしまうため。
  // 利用者にとって意味があるのは「日付の根拠」と「時刻が実測かどうか」で、
  // どちらも上に書いてある。
  lines.push('自動同期: ' + MARKER + timeNote_(event));
  return lines.join('\n');
}

/**
 * 発表時刻の出どころの断り書き。
 *
 * 一次情報（発表機関の予定表）から来た時刻には何も書かない。それが当たり前。
 * そうでないときだけ、何を見ているのかを必ず書く。とくに暫定値は、
 * 「未確認」とはっきり言わないと、確かな時刻のように見えてしまう。
 */
function timeNote_(event) {
  if (event.allDay || CONFIG.display.allDay) return '';
  if (event.timeSource === 'official') return '';
  if (event.timeSource === 'reported') return '（発表時刻は集計サイト由来）';
  return '（発表時刻は未確認の暫定値）';
}

/** 週次まとめの本文。その週に何があるかの一覧だけを出す。 */
function renderDigestDescription_(event) {
  return String(event.note || '').trim() + '\n\n自動同期: ' + MARKER;
}

/**
 * 日付が未確定のときの断り書き。
 *
 * 同じ「未確定」でも中身が違う。CPI の 12 日は過去の慣例からの推定だが、
 * FOMC の会合日は Fed が公表したものを人が書き写しただけで、推定では
 * ない（照合できていないだけ）。どちらにも同じ文言を出すと嘘になる。
 *
 * 見分けるのは発表規則の有無で、勝った情報源では見ない。情報源が入れ替わる
 * たびに説明文が変わると、中身は同じなのに更新が走り続けるため。
 */
function estimatedNote_(event) {
  const indicator = indicator_(event.indicatorId);
  const hasRule = !!(indicator && indicator.schedule && indicator.schedule.type
                     && indicator.schedule.type !== 'none');
  if (hasRule) {
    return 'この日付は過去の慣例から推定したものです。公式発表で前後する可能性があります。';
  }
  return 'この日程は手元の表に書かれたまま、公式ページと照合できていません。'
       + '公式の発表で確認してください。';
}

/** 実行ログやダイジェスト用の1行表示。 */
function renderLine_(event) {
  const local = formatClock_(event.start, CONFIG.timezone);
  const when = local.short + '(' + local.weekday + ')'
             + (event.allDay || CONFIG.display.allDay ? '' : ' ' + local.time);
  const flag = lookup_(FLAGS, event.country, '  ');
  // 「~」だと指標名の一部に見えてしまうので、日本語で書く。
  const mark = isEstimated_(event) ? ' (日付未確定)' : '';
  let figures = '';
  if (event.actual) {
    figures = '  結果 ' + event.actual + (event.forecast ? ' / 予想 ' + event.forecast : '');
  } else if (event.forecast) {
    figures = '  予想 ' + event.forecast;
  }
  return when + ' ' + lookup_(TIER_EMOJI, eventTier_(event), '') + flag + ' ' + event.title + mark + figures;
}

/** 週次まとめの予定かどうか。 */
function isDigest_(event) {
  return event.indicatorId === DIGEST_ID;
}
