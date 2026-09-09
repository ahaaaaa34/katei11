/**
 * 週次ダイジェスト：月曜に「今週の注目指標」を終日予定として置く。
 *
 * カレンダーをめくれば各日の予定は分かるが、「どの週が山場か」は分からない。
 * 普通のイベントとして出力するので、同期の冪等性はそのまま効く。
 */

const DIGEST_ID = 'digest_weekly';

function weeklyDigestEvents_(events, ctx) {
  if (!CONFIG.digest.weeklyEvent) return [];
  const threshold = CONFIG.digest.weeklyThreshold || 75;
  const timezone = ctx.timezone;
  const out = [];

  // 範囲に含まれる月曜を列挙する（範囲が週の途中から始まる週は作らない）。
  let monday = addDays_(ctx.start, -weekdayOf_(ctx.start));
  for (; monday.getTime() <= ctx.end.getTime(); monday = addDays_(monday, 7)) {
    if (monday.getTime() < ctx.start.getTime()) continue;
    const sunday = addDays_(monday, 6);

    const week = events.filter(function (event) {
      if (event.impact < threshold) return false;
      const day = localDate_(event.start, timezone);
      return day.getTime() >= monday.getTime() && day.getTime() <= sunday.getTime();
    }).sort(function (a, b) { return a.start - b.start; });
    if (!week.length) continue;

    const top = week.filter(function (event) { return eventTier_(event) === 'S'; });
    const headline = (top.length ? top : [week[0]]).map(function (event) {
      return event.title;
    }).join('・');
    const anchor = zonedTime_(monday, '00:00', timezone);

    out.push(makeEvent_({
      indicatorId: DIGEST_ID,
      title: '今週の注目指標 ' + week.length + '件'
           + (top.length ? '（最重要 ' + top.length + '件）' : ''),
      start: anchor,
      end: new Date(anchor.getTime() + 86400000),
      impact: 1,          // 通知を出さず、色も控えめにする
      country: 'US',
      category: 'market',
      source: 'digest',
      allDay: true,
      note: '今週の山場: ' + headline + '\n\n'
          + week.map(renderLine_).join('\n'),
    }));
  }
  return out;
}

/** Webhook や実行ログに流す用のテキスト。 */
function digestText_(events, ctx) {
  const lines = ['📊 経済指標 ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end), ''];
  let current = null;
  events.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (event) {
    const local = formatClock_(event.start, ctx.timezone);
    if (local.date !== current) {
      current = local.date;
      lines.push('*' + local.short + '(' + local.weekday + ')*');
    }
    lines.push('  ' + renderLine_(event));
  });
  if (lines.length === 2) lines.push('（該当なし）');
  return lines.join('\n');
}

/** Slack / Discord のどちらでも受け取れる形で送る。 */
function postWebhook_(text) {
  const url = prop_(PROP_WEBHOOK_URL);
  if (!url) return false;
  const body = text.length <= 3500 ? text : text.slice(0, 3497) + '...';
  const response = fetchText_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: body, content: body }),
  });
  return response !== null;
}
