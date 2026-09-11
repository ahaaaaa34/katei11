/**
 * 入口。エディタ上部のプルダウンから選んで実行する関数はここにあります。
 *
 *   setup()             ← 最初に1回だけ実行する（これだけで全自動になります）
 *   syncCalendar()      自動実行の本体。手で押しても構いません
 *   preview()           カレンダーに書き込まず、選抜結果をログに出す
 *   showStatus()        設定・情報源・メンテナンス状況の確認
 *   removeAllEvents()   このツールが作った予定を削除する
 *   uninstall()         自動実行を止める（予定は残ります）
 *   dataQuality()       いま入っているデータがどれだけ確かかを点検する
 *   verifyRules()       発表規則の当たり具合を、FRED の実績で測る
 *   checkFomcAutoFetch() FOMC 日程の自動取得が今どう動くかを確かめる
 *   runTests()          日付計算などの自己テスト
 */

const TRIGGER_HANDLER = 'syncCalendar';

/** 同時実行を待つ上限。これを超えたらこの回は諦める（次の回で追いつく）。 */
const LOCK_WAIT_MS = 30000;

/**
 * 設定を読んで、おかしければ「どこがどうおかしいか」を言って止まる。
 *
 * CONFIG は利用者が直接書き換える場所なので、消し方によっては
 * 「Cannot read properties of undefined」のような、原因の分からない
 * エラーになる。それだと放置運用では手の打ちようがない。
 */
function validateConfig_() {
  const problems = [];

  try {
    tzParts_(new Date(), CONFIG.timezone);
  } catch (err) {
    problems.push('timezone が不正です: ' + CONFIG.timezone
                  + '（例: Asia/Tokyo）');
  }

  const window = CONFIG.window;
  if (!window || typeof window !== 'object') {
    problems.push('window の設定がありません（daysAhead / daysBack）');
  } else {
    ['daysAhead', 'daysBack'].forEach(function (key) {
      const value = window[key];
      if (typeof value !== 'number' || value < 0 || value !== Math.floor(value)) {
        problems.push('window.' + key + ' は 0 以上の整数にしてください: ' + value);
      }
    });
    if (window.daysAhead > 400) problems.push('window.daysAhead は 400 日以内にしてください');
  }

  const calendar = CONFIG.calendar;
  if (!calendar || typeof calendar !== 'object') {
    problems.push('calendar の設定がありません（name か id）');
  } else if (!calendar.id && !calendar.name) {
    problems.push('calendar.name か calendar.id のどちらかは必要です');
  }

  const impact = CONFIG.filter && CONFIG.filter.minImpact;
  if (typeof impact !== 'number' || impact < 0 || impact > 100) {
    problems.push('filter.minImpact は 0〜100 の数値にしてください: ' + impact);
  }

  TIERS.forEach(function (tier) {
    const list = (CONFIG.reminders || {})[tier];
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      problems.push('reminders.' + tier + ' は配列にしてください');
      return;
    }
    list.forEach(function (minutes) {
      if (typeof minutes !== 'number' || minutes < 0 || minutes > 40320) {
        problems.push('reminders.' + tier + ' は 0〜40320 分の数値にしてください: ' + minutes);
      }
    });
  });

  TIERS.forEach(function (tier) {
    const color = (CONFIG.colors || {})[tier];
    if (color === undefined || color === null || color === '') return;
    const number = Number(color);
    if (!Number.isInteger(number) || number < 1 || number > 11
        || String(number) !== String(color).trim()) {
      // Google が受け付けるのは 1〜11 だけ。ここで弾かないと、同期のたびに
      // 予定の作成が失敗して原因が分からなくなる。
      problems.push('colors.' + tier + ' は "1"〜"11" にしてください: ' + color);
    }
  });

  problems.push.apply(problems, catalogProblems_());

  const triggers = CONFIG.triggers;
  if (!triggers || typeof triggers !== 'object') {
    problems.push('triggers の設定がありません（morningHour / eveningHour）');
  } else {
    ['morningHour', 'eveningHour'].forEach(function (key) {
      const hour = triggers[key];
      if (typeof hour !== 'number' || hour < 0 || hour > 23) {
        problems.push('triggers.' + key + ' は 0〜23 にしてください: ' + hour);
      }
    });
  }

  if (problems.length) {
    throw new Error('設定に問題があります（00_config.js を確認してください）:\n  - '
                    + problems.join('\n  - '));
  }
}

/**
 * 指標カタログの書式を点検する。利用者が 01_indicators.js を触ったときに、
 * その指標が黙ってカレンダーから消えるのを防ぐ。
 */
function catalogProblems_() {
  const validTypes = ['nth_business_day', 'nth_weekday', 'day_of_month', 'weekly', 'none'];
  const problems = [];
  const seen = {};

  INDICATORS.forEach(function (indicator) {
    const id = indicator.id || '(id なし)';
    if (!indicator.id) problems.push('id の無い指標があります: ' + indicator.name);
    if (seen[id]) problems.push('指標 id が重複しています: ' + id);
    seen[id] = true;

    if (typeof indicator.impact !== 'number' || indicator.impact < 0 || indicator.impact > 100) {
      problems.push(id + ': impact は 0〜100 の数値にしてください');
    }

    const schedule = indicator.schedule || {};
    const type = schedule.type || 'none';
    if (validTypes.indexOf(type) === -1) {
      problems.push(id + ': schedule.type が不正です（' + type + '）');
    }
    if (schedule.weekday !== undefined
        && WEEKDAY_NUM[String(schedule.weekday).toLowerCase()] === undefined) {
      problems.push(id + ': schedule.weekday が不正です（' + schedule.weekday + '）');
    }
    // time は schedule.type が none の指標でも使う（FOMC や外部取得ぶんの
    // 時刻になる）ので、書いてあるなら必ず検査する。
    if (indicator.time !== undefined && indicator.time !== null) {
      const parts = /^(\d{1,2}):(\d{2})$/.exec(String(indicator.time));
      if (!parts || Number(parts[1]) > 23 || Number(parts[2]) > 59) {
        problems.push(id + ': time が不正です（' + indicator.time + '）');
      }
    } else if (type !== 'none' && !indicator.all_day) {
      problems.push(id + ': 発表日を計算する指標には time が必要です');
    }
    if (indicator.tz) {
      try {
        tzParts_(new Date(), indicator.tz);
      } catch (err) {
        problems.push(id + ': tz が不正です（' + indicator.tz + '）');
      }
    }
  });
  return problems;
}

/**
 * 拡張サービスの Calendar API が有効かを確かめる。
 * 有効化を忘れると "Calendar is not defined" としか出ず、原因に辿り着けない。
 */
function requireCalendarService_() {
  if (typeof Calendar === 'undefined' || !Calendar.Events) {
    throw new Error(
      'Calendar API が有効になっていません。\n'
      + 'エディタ左の [サービス] の ＋ から Calendar API を追加してください'
      + '（識別子は Calendar のまま）。');
  }
}

/**
 * 最初の1回。カレンダーを用意し、自動実行を仕掛け、初回同期まで済ませます。
 * 2回目以降に実行しても安全です（トリガーは重複しません）。
 */
function setup() {
  validateConfig_();
  requireCalendarService_();
  const calendarId = resolveCalendarId_(true);
  installTriggers();
  const plan = syncCalendar();

  const lines = [
    '─────────────────────────────',
    ' セットアップ完了',
    '─────────────────────────────',
    'カレンダー : ' + CONFIG.calendar.name,
    'ID         : ' + calendarId,
    '同期結果   : ' + (plan ? planSummary_(plan) : '(別の実行中だったのでスキップ)'),
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
  validateConfig_();
  requireCalendarService_();

  // 手動実行と自動実行がぶつかっても、同じ書き込みを二重に投げないようにする。
  // 取れなければ既に別の実行が同じ仕事をしているので、この回は何もしない。
  const lock = acquireLock_();
  if (!lock) {
    log_('別の同期が実行中のため、この回はスキップします。');
    return null;
  }

  const ctx = syncWindow_();
  try {
    let events = collectEvents_(ctx);
    if (!events.length) {
      throw new Error('同期対象が 0 件でした。条件か情報源の状態を確認してください。');
    }
    events = events.concat(weeklyDigestEvents_(events, ctx));

    // カレンダーを消されていた場合に一度だけ探し直す。
    const plan = withCalendarRecovery_(function () {
      const calendarId = resolveCalendarId_(true);
      const existing = listManagedEvents_(calendarId, ctx.start, ctx.end);
      return applyPlan_(buildPlan_(calendarId, events, existing, ctx));
    });

    log_('期間 ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end)
         + ' / ' + planSummary_(plan));

    notifyMaintenance_(maintenanceReport_(ctx));
    maybeSendWeeklyDigest_(events, ctx);
    return plan;
  } catch (error) {
    log_('同期に失敗しました: ' + error);
    notifyFailure_(error);
    throw error;   // 実行履歴にも失敗として残す
  } finally {
    releaseLock_(lock);
  }
}

function acquireLock_() {
  try {
    const lock = LockService.getScriptLock();
    return lock.tryLock(LOCK_WAIT_MS) ? lock : null;
  } catch (err) {
    // ロックが使えない環境でも、同期そのものは冪等なので続行する。
    log_('排他ロックを使えませんでした（処理は続行します）: ' + err);
    return { releaseLock: function () {} };
  }
}

function releaseLock_(lock) {
  try {
    if (lock && lock.releaseLock) lock.releaseLock();
  } catch (err) {
    log_('ロックを解放できませんでした: ' + err);
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
  validateConfig_();
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
  let last = '';
  let verified = 0;
  meetings.forEach(function (meeting) {
    if (meeting.date > last) last = meeting.date;
    if (meeting.confidence === 'official') verified++;
  });
  return last + ' まで / 公式と照合済み ' + verified + ' 件中 ' + meetings.length + ' 件';
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

/**
 * いまカレンダーに入る予定が、どれだけ確かな根拠に基づいているかを出す。
 *
 * 「正しいデータが入っているか」を自分で確かめられるようにするための関数。
 * 数えるだけでなく、確かにするために何をすればよいかまで書く。
 */
function dataQuality() {
  validateConfig_();
  const ctx = syncWindow_();
  const events = collectEvents_(ctx);

  const counts = { official: 0, reported: 0, rule: 0, estimated: 0 };
  const estimatedBy = {};
  events.forEach(function (event) {
    counts[event.confidence] = (counts[event.confidence] || 0) + 1;
    if (isEstimated_(event)) {
      estimatedBy[event.indicatorId] = (estimatedBy[event.indicatorId] || 0) + 1;
    }
  });

  const lines = [];
  lines.push('期間 ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end)
             + ' / ' + events.length + ' 件');
  lines.push('');
  lines.push('■ 日付の根拠');
  ['official', 'reported', 'rule', 'estimated'].forEach(function (key) {
    const bar = new Array(Math.round((counts[key] || 0) / 2) + 1).join('■');
    lines.push('   ' + (CONFIDENCE_LABEL[key] + '          ').slice(0, 10)
               + String(counts[key] || 0).padStart(3) + ' 件 ' + bar);
  });

  const estimatedIds = Object.keys(estimatedBy);
  if (estimatedIds.length) {
    lines.push('');
    lines.push('■ 日付が未確定のもの（件名に「(予定日未確定)」と出ます）');
    estimatedIds.sort().forEach(function (id) {
      const indicator = indicator_(id);
      lines.push('   ' + (indicator ? indicator.name : id)
                 + ' × ' + estimatedBy[id] + '回');
    });
  }

  lines.push('');
  lines.push('■ FOMC 会合日程');
  lines.push('   ' + fomcVerificationStatus_());

  const warnings = fredMatchWarnings_();
  if (warnings.length) {
    lines.push('');
    lines.push('■ FRED の対応付けに疑いあり');
    warnings.forEach(function (text) { lines.push('   ' + text); });
  }

  lines.push('');
  lines.push('■ 確かさを上げるには');
  if (!prop_(PROP_FRED_KEY)) {
    lines.push('   1. FRED の無料キーを取得して、スクリプト プロパティ '
               + PROP_FRED_KEY + ' に入れる');
    lines.push('      → 主要10指標の発表日が公式の確定値になります');
    lines.push('      https://fred.stlouisfed.org/docs/api/api_key.html');
  } else {
    lines.push('   ✅ FRED キーは設定済み');
  }
  if (!CONFIG.providers.investing) {
    lines.push('   2. 00_config.js の providers.investing を true にする');
    lines.push('      → 発表時刻が実測値になり、予想値・前回値・結果値が入ります');
  } else {
    lines.push('   ✅ Investing は有効（時刻と数値が入ります）');
  }
  lines.push('   3. verifyRules() を実行すると、発表規則の当たり具合が測れます');

  lines.push('');
  lines.push('※ 影響度スコアと解説文は、データではなく作成者の判断です。');

  const text = lines.join('\n');
  log_(text);
  return text;
}

function fomcVerificationStatus_() {
  const meetings = allMeetings_('fomc');
  if (!meetings.length) return '未登録';
  const byConfidence = {};
  meetings.forEach(function (meeting) {
    byConfidence[meeting.confidence] = (byConfidence[meeting.confidence] || 0) + 1;
  });
  if (byConfidence.official === meetings.length) {
    return '公式ページと照合済み（' + meetings.length + ' 回ぶん）';
  }
  if (!byConfidence.official) {
    return '未照合（' + meetings.length + ' 回ぶん）'
         + ' — 公式ページを取得できていません。checkFomcAutoFetch() で確認してください';
  }
  return '一部だけ照合済み（照合 ' + byConfidence.official + ' / 未照合 '
       + (meetings.length - byConfidence.official) + '）';
}

/**
 * 発表規則がどれだけ当たっているかを、FRED の過去の実績で測って表示する。
 * 「第1営業日」「12日ごろ」といった規則は人が書いたものなので、
 * 信じてよいかどうかは測らないと分からない。
 */
function verifyRules() {
  validateConfig_();
  if (!prop_(PROP_FRED_KEY)) {
    const message = 'FRED のキーが必要です。スクリプト プロパティ ' + PROP_FRED_KEY
                  + ' に設定してください。\n'
                  + 'https://fred.stlouisfed.org/docs/api/api_key.html';
    log_(message);
    return message;
  }

  const stats = measureRuleAccuracy_(12);
  if (stats === null) {
    const message = 'FRED から過去の発表日を取得できませんでした。';
    log_(message);
    return message;
  }
  if (!stats.length) {
    const message = '突き合わせられる実績がありませんでした。';
    log_(message);
    return message;
  }

  const lines = ['過去12か月の実際の発表日と、発表規則の予想を突き合わせた結果', '',
                 '  ずれ(平均)  的中率  最大ずれ  指標', ''];
  stats.forEach(function (entry) {
    lines.push('  ' + (entry.meanGap + ' 日').padStart(8)
               + (entry.exactRate + '%').padStart(8)
               + (entry.worst + ' 日').padStart(10)
               + '  ' + entry.name + '（' + entry.samples + '件）');
  });
  lines.push('');
  lines.push('ずれが大きい指標は、01_indicators.js の schedule を見直す価値があります。');
  lines.push('なお FRED が扱う指標は、実際の同期では公式の発表日が使われるので、');
  lines.push('規則のずれはカレンダーには出ません。ここで効くのは FRED が扱わない指標です。');

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
  const items = withCalendarRecovery_(function () {
    const calendarId = resolveCalendarId_(false);
    const found = listManagedEvents_(calendarId, ctx.start, ctx.end);
    found.forEach(function (item) {
      try {
        calendarCall_(function () { return Calendar.Events.remove(calendarId, item.id); });
      } catch (err) {
        if (!isMissingError_(err)) throw err;
      }
    });
    return found;
  });
  const message = items.length + ' 件を削除しました。';
  log_(message);
  return message;
}
