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
  if (CONFIG.display.impactEmoji) parts.push(TIER_EMOJI[tier]);
  if (CONFIG.display.countryFlag && FLAGS[event.country]) parts.push(FLAGS[event.country]);
  parts.push(event.title);
  if (CONFIG.display.showScore) parts.push('[' + event.impact + ']');
  if (event.actual) parts.push('→ ' + event.actual);
  else if (event.estimated) parts.push('(予定日未確定)');
  return parts.join(' ');
}

function formatClock_(instant, timezone) {
  const parts = tzParts_(instant, timezone);
  const date = ymd_(parts.year, parts.month, parts.day);
  return {
    date: parts.year + '/' + pad2_(parts.month) + '/' + pad2_(parts.day),
    time: pad2_(parts.hour % 24) + ':' + pad2_(parts.minute),
    weekday: WEEKDAY_JA[weekdayOf_(date)],
    short: pad2_(parts.month) + '/' + pad2_(parts.day),
  };
}

function renderDescription_(event) {
  const tier = eventTier_(event);
  const local = formatClock_(event.start, CONFIG.timezone);
  const lines = [];

  lines.push('影響度  ' + stars_(event.impact) + '  ' + event.impact + '/100 '
             + '（' + tier + 'ランク・' + TIER_LABEL[tier] + '）');
  lines.push('分類    ' + (CATEGORY_LABEL[event.category] || event.category));
  if (event.allDay) {
    lines.push('日時    ' + local.date + '(' + local.weekday + ') 終日');
  } else {
    const eastern = formatClock_(event.start, ET);
    lines.push('日時    ' + local.date + '(' + local.weekday + ') ' + local.time
               + '  (現地 ' + eastern.time + ' ET)');
  }
  if (event.period) lines.push('対象期間 ' + event.period);

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
  if (event.estimated) {
    lines.push('⚠️ この日付は過去の慣例から推定したものです。'
               + '公式発表で前後する可能性があります。');
  }
  if (event.url) lines.push('🔗 ' + event.url);
  lines.push('情報源: ' + event.source + ' / 自動同期: ' + MARKER);
  return lines.join('\n');
}

/** 実行ログやダイジェスト用の1行表示。 */
function renderLine_(event) {
  const local = formatClock_(event.start, CONFIG.timezone);
  const when = local.short + '(' + local.weekday + ') '
             + (event.allDay ? '終日  ' : local.time);
  const flag = FLAGS[event.country] || '  ';
  const mark = event.estimated ? '~' : ' ';
  let figures = '';
  if (event.actual) {
    figures = '  結果 ' + event.actual + (event.forecast ? ' / 予想 ' + event.forecast : '');
  } else if (event.forecast) {
    figures = '  予想 ' + event.forecast;
  }
  return when + ' ' + TIER_EMOJI[eventTier_(event)] + flag + ' ' + event.title + mark + figures;
}
