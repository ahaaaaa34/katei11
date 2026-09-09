/**
 * 入口。エディタ上部のプルダウンから選んで実行する関数はここにあります。
 *
 *   setup()             ← 最初に1回だけ実行する（これだけで全自動になります）
 *   syncCalendar()      自動実行の本体。手で押しても構いません
 *   preview()           カレンダーに書き込まず、選抜結果をログに出す
 *   showStatus()        設定・情報源・メンテナンス状況の確認
 *   removeAllEvents()   このツールが作った予定を削除する
 *   uninstall()         自動実行を止める（予定は残ります）
 *   checkFomcAutoFetch() FOMC 日程の自動取得が今どう動くかを確かめる
 *   runTests()          日付計算などの自己テスト
 */

const TRIGGER_HANDLER = 'syncCalendar';

/**
 * 最初の1回。カレンダーを用意し、自動実行を仕掛け、初回同期まで済ませます。
 * 2回目以降に実行しても安全です（トリガーは重複しません）。
 */
function setup() {
  const calendarId = resolveCalendarId_(true);
  installTriggers();
  const plan = syncCalendar();

  const lines = [
    '─────────────────────────────',
    ' セットアップ完了',
    '─────────────────────────────',
    'カレンダー : ' + CONFIG.calendar.name,
    'ID         : ' + calendarId,
    '同期結果   : ' + (plan ? planSummary_(plan) : '(失敗)'),
    '自動実行   : 毎日 ' + CONFIG.triggers.morningHour + '時ごろ / '
                 + CONFIG.triggers.eveningHour + '時ごろ',
    '',
    'このあとやることはありません。Google カレンダーを開いて確認してください。',
  ];
  log_(lines.join('\n'));
  return lines.join('\n');
}

/** 自動実行の本体。 */
function syncCalendar() {
  const ctx = syncWindow_();
  try {
    let events = collectEvents_(ctx);
    if (!events.length) {
      throw new Error('同期対象が 0 件でした。条件か情報源の状態を確認してください。');
    }
    events = events.concat(weeklyDigestEvents_(events, ctx));

    const calendarId = resolveCalendarId_(true);
    const existing = listManagedEvents_(calendarId, ctx.start, ctx.end);
    const plan = applyPlan_(buildPlan_(calendarId, events, existing));

    log_('期間 ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end)
         + ' / ' + planSummary_(plan));

    notifyMaintenance_(maintenanceReport_(ctx));
    maybeSendWeeklyDigest_(events, ctx);
    return plan;
  } catch (error) {
    log_('同期に失敗しました: ' + error);
    notifyFailure_(error);
    throw error;   // 実行履歴にも失敗として残す
  }
}

/** 月曜の朝の回だけ、今週のまとめを Webhook に流す。 */
function maybeSendWeeklyDigest_(events, ctx) {
  if (!prop_(PROP_WEBHOOK_URL)) return;
  const now = tzParts_(new Date(), CONFIG.timezone);
  const today = ymd_(now.year, now.month, now.day);
  if (weekdayOf_(today) !== 0 || now.hour >= 12) return;

  const week = { start: today, end: addDays_(today, 6), timezone: ctx.timezone };
  const inWeek = events.filter(function (event) {
    if (event.allDay || event.impact < (CONFIG.digest.weeklyThreshold || 75)) return false;
    const day = localDate_(event.start, ctx.timezone);
    return day.getTime() >= week.start.getTime() && day.getTime() <= week.end.getTime();
  });
  postWebhook_(digestText_(inWeek, week));
}

/** カレンダーに触らず、何が登録されるかをログに出す。 */
function preview() {
  const ctx = syncWindow_();
  const events = collectEvents_(ctx);
  const counts = { S: 0, A: 0, B: 0, C: 0 };
  const lines = ['期間 ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end)
                 + '   ' + events.length + ' 件', ''];
  events.forEach(function (event) {
    counts[eventTier_(event)]++;
    lines.push('  ' + renderLine_(event));
  });
  lines.push('');
  lines.push('内訳: ' + TIERS.map(function (t) { return t + ':' + counts[t]; }).join(' / '));
  lines.push('~ 印は発表日が推定であることを示します。');
  const text = lines.join('\n');
  log_(text);
  return text;
}

/** 設定と情報源の状態、手当てが要る項目を表示する。 */
function showStatus() {
  const ctx = syncWindow_();
  // fomcAutoFetch は情報源ではなく fomc の挙動スイッチなので、ここには並べない。
  const enabled = Object.keys(CONFIG.providers).filter(function (name) {
    return CONFIG.providers[name] && name !== 'fomcAutoFetch';
  });
  const lines = [
    'タイムゾーン : ' + CONFIG.timezone,
    '同期期間     : ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end),
    '選抜しきい値 : 影響度 ' + CONFIG.filter.minImpact + ' 以上',
    '指標カタログ : ' + INDICATORS.length + ' 件（うちルール展開 '
                    + indicatorsWithRules_().length + ' 件）',
    '有効な情報源 : ' + enabled.join(', '),
    'FOMC 日程    : ' + meetingCoverage_(),
    'FRED キー    : ' + (prop_(PROP_FRED_KEY) ? '設定済み' : '未設定'),
    'Webhook      : ' + (prop_(PROP_WEBHOOK_URL) ? '設定済み' : '未設定'),
    '自動実行     : ' + countTriggers_() + ' 件',
    '',
    maintenanceText_(maintenanceReport_(ctx)),
  ];
  const text = lines.join('\n');
  log_(text);
  return text;
}

function meetingCoverage_() {
  const meetings = allMeetings_('fomc');
  if (!meetings.length) return '未登録';
  let manual = '', auto = '';
  meetings.forEach(function (meeting) {
    if (meeting.auto) { if (meeting.date > auto) auto = meeting.date; }
    else if (meeting.date > manual) manual = meeting.date;
  });
  return '手入力 ' + (manual || 'なし') + ' まで'
       + (auto ? ' / 自動取得 ' + auto + ' まで' : '');
}

/**
 * FOMC 日程の自動取得が実際にどう動くかを見る。
 * 公式ページの作りが変わっていないか、たまに確認するのに使う。
 */
function checkFomcAutoFetch() {
  const lines = ['取得先: ' + FOMC_CALENDAR_URL, ''];
  const html = fetchText_(FOMC_CALENDAR_URL);
  if (html === null) {
    lines.push('❌ ページを取得できませんでした（手入力の日程だけで動きます）');
    const text = lines.join('\n');
    log_(text);
    return text;
  }

  let years = {};
  try {
    years = parseFomcCalendar_(html);
  } catch (err) {
    lines.push('❌ 解釈できませんでした: ' + err);
  }

  const found = Object.keys(years).sort();
  if (!found.length) {
    lines.push('❌ 会合日程を見つけられませんでした（ページの作りが変わった可能性）');
  }
  found.forEach(function (year) {
    const problem = validateFomcYear_(years[year], Number(year));
    lines.push((problem ? '❌ ' : '✅ ') + year + ' 年  ' + years[year].length + ' 回'
               + (problem ? '  → 採用しません: ' + problem : ''));
    lines.push('     ' + years[year].map(function (m) {
      return m.date + (m.sep ? '*' : '');
    }).join('  '));
  });

  lines.push('');
  lines.push('* 印は経済見通し(SEP)が同時公表される回。');
  lines.push('現在の状態: ' + meetingCoverage_());
  lines.push('手入力（02_meetings.js）がある年は、取得結果があっても使いません。');

  const text = lines.join('\n');
  log_(text);
  return text;
}

// ---------------------------------------------------------------------------
// トリガー
// ---------------------------------------------------------------------------

function installTriggers() {
  uninstall();
  [CONFIG.triggers.morningHour, CONFIG.triggers.eveningHour].forEach(function (hour) {
    ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyDays(1).atHour(hour).create();
  });
  log_('自動実行を設定しました（毎日 '
       + CONFIG.triggers.morningHour + '時 / ' + CONFIG.triggers.eveningHour + '時ごろ）');
}

function uninstall() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  if (removed) log_('既存の自動実行 ' + removed + ' 件を解除しました');
  return removed;
}

function countTriggers_() {
  return ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === TRIGGER_HANDLER;
  }).length;
}

// ---------------------------------------------------------------------------
// 後始末
// ---------------------------------------------------------------------------

/** このツールが作った予定を、同期期間の範囲で削除する。 */
function removeAllEvents() {
  const ctx = syncWindow_();
  const calendarId = resolveCalendarId_(false);
  const items = listManagedEvents_(calendarId, ctx.start, ctx.end);
  items.forEach(function (item) {
    try {
      Calendar.Events.remove(calendarId, item.id);
    } catch (err) {
      if (!isMissingError_(err)) throw err;
    }
  });
  const message = items.length + ' 件を削除しました。';
  log_(message);
  return message;
}
