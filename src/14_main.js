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
 *   checkOfficialTimes() 発表予定表（時刻の一次情報）が読めているか確かめる
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
  const problems = configProblems_();
  if (problems.length) {
    throw new Error('設定に問題があります（00_config.js を確認してください）:\n  - '
                    + problems.join('\n  - '));
  }
}

/** 設定の問題を並べて返す（投げない）。困ったときの表示にも使う。 */
function configProblems_() {
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

  return problems;
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

    if (indicator.duration !== undefined
        && (typeof indicator.duration !== 'number' || indicator.duration <= 0
            || indicator.duration > 24 * 60)) {
      problems.push(id + ': duration は 1〜1440 分にしてください（' + indicator.duration + '）');
    }
    if (indicator.period_offset !== undefined
        && (typeof indicator.period_offset !== 'number'
            || Math.abs(indicator.period_offset) > 12)) {
      problems.push(id + ': period_offset が不正です（' + indicator.period_offset + '）');
    }
    // 解説の出典は一次情報であってほしい。せめて https だけは確かめる。
    if (indicator.url && String(indicator.url).indexOf('https://') !== 0) {
      problems.push(id + ': url は https にしてください（' + indicator.url + '）');
    }
    // 名寄せに使う文字列。空や重複があると、別の指標の数値が入りこむ。
    (indicator.match || []).forEach(function (pattern) {
      if (typeof pattern !== 'string' || !pattern.trim()) {
        problems.push(id + ': match に空の項目があります');
      }
    });
    if (indicator.fred_release !== undefined) {
      try {
        new RegExp(indicator.fred_release, 'i');
      } catch (err) {
        problems.push(id + ': fred_release が正規表現として不正です（'
                      + indicator.fred_release + '）');
      }
    }
  });

  problems.push.apply(problems, fredReleaseOverlaps_());
  return problems;
}

/**
 * ひとつの FRED release 名が2つ以上の指標に当たっていないか。
 *
 * 当たってしまうと、関係ない発表日が「公式の日付」として別の指標に
 * 入りこむ。実際の release 名は取ってこないと分からないので、ここでは
 * カタログどうしを突き合わせ、「A の名前が B の正規表現にも当たる」
 * という書き方の重なりだけを見る。
 */
function fredReleaseOverlaps_() {
  const withRelease = INDICATORS.filter(function (i) { return i.fred_release; });
  const problems = [];
  const reported = {};
  withRelease.forEach(function (a) {
    withRelease.forEach(function (b) {
      if (a.id === b.id) return;
      let re;
      try { re = new RegExp(b.fred_release, 'i'); } catch (err) { return; }
      // a の正規表現から「素の名前らしき部分」を作って b に当ててみる。
      const plain = String(a.fred_release).replace(/[\^$]/g, '');
      if (!/^[\w .,&'()-]+$/.test(plain)) return;   // 込み入った式は対象外
      if (!re.test(plain)) return;
      const pair = [a.id, b.id].sort().join(' と ');
      if (reported[pair]) return;   // 同じ組を2回言わない
      reported[pair] = true;
      problems.push('FRED の対応付けが重なっています: 「' + plain + '」は '
                    + pair + ' の両方に当たります');
    });
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
    const collected = collectEvents_(ctx);
    if (!collected.length) {
      throw new Error('同期対象が 0 件でした。条件か情報源の状態を確認してください。');
    }
    // 週次ダイジェストの通知に使うため、実際に入る姿を外へ持ち出す。
    let shownEvents = collected;

    // カレンダーを消されていた場合に一度だけ探し直す。
    const plan = withCalendarRecovery_(function () {
      const calendarId = resolveCalendarId_(true);
      const existing = listManagedEvents_(calendarId, ctx.start, ctx.end);
      // 週次まとめは各予定の一覧を本文に持つので、実際にカレンダーへ入る
      // 姿から作る。そうしないと、情報源が揺れるたびにまとめだけが変わる。
      const enriched = inheritFromExisting_(collected, existing);
      shownEvents = displayEvents_(collected, existing);
      const events = enriched.concat(weeklyDigestEvents_(shownEvents, ctx));
      return applyPlan_(buildPlan_(calendarId, events, existing, ctx));
    });

    const down = downSources_();
    log_('期間 ' + dateKey_(ctx.start) + ' 〜 ' + dateKey_(ctx.end)
         + ' / ' + planSummary_(plan)
         + (down.length ? ' / 今回つながらなかった情報源: ' + down.join(', ')
                          + '（その予定はそのまま残しました）' : ''));

    notifyMaintenance_(maintenanceReport_(ctx));
    maybeSendWeeklyDigest_(shownEvents, ctx);
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

/**
 * 月曜の朝の回だけ、今週のまとめを Webhook に流す。
 *
 * 「月曜の午前」という条件だけだと、手で実行するたび・自動実行が二重に
 * 走るたびに、同じまとめが何度も飛ぶ。送った週を控えて1週に1回にする。
 */
function maybeSendWeeklyDigest_(events, ctx) {
  if (!prop_(PROP_WEBHOOK_URL)) return false;
  const now = tzParts_(new Date(), CONFIG.timezone);
  const today = ymd_(now.year, now.month, now.day);
  if (weekdayOf_(today) !== 0 || now.hour >= 12) return false;

  const thisWeek = dateKey_(today);
  if (prop_(PROP_LAST_DIGEST_WEEK) === thisWeek) return false;

  const week = { start: today, end: addDays_(today, 6), timezone: ctx.timezone };
  const inWeek = events.filter(function (event) {
    if (event.allDay || event.impact < (CONFIG.digest.weeklyThreshold || 75)) return false;
    const day = localDate_(event.start, ctx.timezone);
    return day.getTime() >= week.start.getTime() && day.getTime() <= week.end.getTime();
  });
  if (!postWebhook_(digestText_(inWeek, week))) return false;
  try {
    props_().setProperty(PROP_LAST_DIGEST_WEEK, thisWeek);
  } catch (err) {
    log_('まとめを送った控えを保存できませんでした: ' + err);
  }
  return true;
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
  lines.push('「(日付未確定)」は、発表日がまだ確定していないことを示します。');
  const text = lines.join('\n');
  log_(text);
  return text;
}

/**
 * 設定と情報源の状態、手当てが要る項目を表示する。
 *
 * これは「うまく動かないとき」に見る画面なので、設定が壊れていても
 * 落ちてはいけない。壊れているならその中身を出す。
 */
function showStatus() {
  const problems = configProblems_();
  if (problems.length) {
    const text = ['設定に問題があります（00_config.js を確認してください）']
      .concat(problems.map(function (p) { return '  - ' + p; }))
      .concat(['', '直してから、もう一度 showStatus() を実行してください。']).join('\n');
    log_(text);
    return text;
  }
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
  ];

  const unreachable = unreachableIndicators_(false);
  if (unreachable.length) {
    lines.push('');
    lines.push('この設定では出てこない指標（選抜条件は通っています）:');
    unreachable.forEach(function (row) { lines.push('  ・ ' + row); });
  }

  lines.push('');
  lines.push(maintenanceText_(maintenanceReport_(ctx)));
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
  return last + ' まで / ' + meetings.length + ' 件中 ' + verified + ' 件が公式と照合済み';
}

/**
 * 「カタログには載っているのに、いまの設定では絶対に出てこない指標」。
 *
 * いちばん気づきにくい壊れ方は、エラーも出ず、ただ永久に出てこないこと。
 * 日銀の会合を待っていたのに 02_meetings.js が空のまま、というのがその例。
 * 選抜条件を通るのに出しようが無いものは、理由を添えて挙げておく。
 *
 * all を true にすると、選抜条件で外れているものも含めて全部返す。
 */
function unreachableIndicators_(all) {
  const rows = [];
  INDICATORS.forEach(function (indicator) {
    if (!all && !selectedByFilter_(indicator)) return;
    const why = whyUnreachable_(indicator);
    if (why) rows.push(indicator.name + ' — ' + why);
  });
  return rows;
}

/** その指標が、いまの選抜条件を通るか（発表日の有無は見ない）。 */
function selectedByFilter_(indicator) {
  return applyFilter_([{
    indicatorId: indicator.id, impact: indicator.impact,
    country: indicator.country, category: indicator.category,
  }]).length > 0;
}

/** 出てこない理由。出てくるなら空文字。 */
function whyUnreachable_(indicator) {
  const providers = CONFIG.providers || {};
  const schedule = indicator.schedule || {};
  if (schedule.type && schedule.type !== 'none') {
    return providers.rules ? '' : '発表日のルール計算 (providers.rules) が無効です';
  }

  const bank = lookup_(MEETING_INDICATORS, indicator.id, null);
  if (bank) {
    if (!providers.fomc) return '中央銀行の会合 (providers.fomc) が無効です';
    if (allMeetings_(bank).length) return '';
    const section = MEETINGS[bank] || {};
    return '会合日程が未登録です（02_meetings.js の ' + bank + ' に追記してください'
           + (section.verify_url ? ' / 確認先: ' + section.verify_url : '') + '）';
  }

  if (String(indicator.id).indexOf('market_') === 0) {
    return providers.market ? '' : '休場・SQ (providers.market) が無効です';
  }

  // 発表規則も会合日程も無い。外から取ってこられるかどうかで決まる。
  if (indicator.fred_release && providers.fred) return '';
  if ((indicator.match || []).length && providers.investing) return '';
  return '発表日を決める手がかりがありません'
       + '（schedule も会合日程も無く、日付を持ってくる情報源も無効です）';
}

/** 会合日程から作られる指標と、その中央銀行。 */
const MEETING_INDICATORS = {
  us_fomc_rate: 'fomc', us_fomc_presser: 'fomc',
  us_fomc_minutes: 'fomc', us_beige_book: 'fomc',
  jp_boj_decision: 'boj', eu_ecb_decision: 'ecb',
};

/**
 * 発表予定表（一次情報）を実際に読みに行って、結果をそのまま見せる。
 *
 * ここが取れているあいだ、カレンダーの発表時刻は機関の公表値そのもの。
 * 取れなくなったら暫定値に落ちるので、たまにこれで確かめる。
 */
function checkOfficialTimes() {
  const ctx = syncWindow_();
  const lines = ['発表予定表（発表時刻の一次情報）', ''];
  resetScheduleMemo_();

  let officialCount = 0;
  (CONFIG.officialSchedules || []).forEach(function (source) {
    lines.push('■ ' + source.name);
    scheduleYears_(ctx).forEach(function (year) {
      const url = String(source.url || '').replace(/\{\{year\}\}/g, String(year));
      lines.push('   ' + url);
      const rows = fetchSchedulePage_(source, year);
      if (rows === null) {
        lines.push('   ❌ 読めませんでした（この機関ぶんの時刻は暫定値に落ちます）');
        return;
      }
      const matched = rows.filter(function (row) { return matchScheduleRelease_(row.name); });
      officialCount += matched.length;
      lines.push('   ✅ ' + rows.length + ' 行 / うちカタログの指標に対応 '
                 + matched.length + ' 件');
      matched.slice(0, 5).forEach(function (row) {
        const indicator = matchScheduleRelease_(row.name);
        lines.push('      ' + dateKey_(row.date) + ' ' + row.time + '  '
                   + indicator.name + '  ← ' + row.name);
      });
      if (matched.length > 5) lines.push('      …ほか ' + (matched.length - 5) + ' 件');
    });
    lines.push('');
  });

  if (!officialCount) {
    lines.push('どの予定表からも指標を拾えていません。');
    lines.push('ページの作りか URL が変わった可能性があります。');
    lines.push('00_config.js の officialSchedules を直してください。');
  }
  const text = lines.join('\n');
  log_(text);
  return text;
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
    lines.push('   ' + (lookup_(CONFIDENCE_LABEL, key, key) + '          ').slice(0, 10)
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

  const byTime = { official: 0, reported: 0, fallback: 0 };
  const fallbackBy = {};
  events.forEach(function (event) {
    if (event.allDay || CONFIG.display.allDay) return;
    byTime[event.timeSource] = (byTime[event.timeSource] || 0) + 1;
    if (event.timeSource === 'fallback') {
      fallbackBy[event.indicatorId] = (fallbackBy[event.indicatorId] || 0) + 1;
    }
  });
  lines.push('');
  lines.push('■ 発表時刻の出どころ');
  ['official', 'reported', 'fallback'].forEach(function (key) {
    const bar = new Array(Math.round((byTime[key] || 0) / 2) + 1).join('■');
    lines.push('   ' + (TIME_LABEL[key] + '            ').slice(0, 12)
               + String(byTime[key] || 0).padStart(3) + ' 件 ' + bar);
  });
  const fallbackIds = Object.keys(fallbackBy).sort();
  if (fallbackIds.length) {
    lines.push('');
    lines.push('   時刻を確かめられていないもの（予定に「未確認の暫定値」と出ます）');
    fallbackIds.forEach(function (id) {
      const indicator = indicator_(id);
      lines.push('     ' + (indicator ? indicator.name : id) + ' × ' + fallbackBy[id] + '回');
    });
    lines.push('   → checkOfficialTimes() で、予定表が読めているか確かめてください。');
  }

  const down = downSources_();
  if (down.length) {
    lines.push('');
    lines.push('■ 今つながらない情報源');
    down.forEach(function (name) { lines.push('   ' + name); });
    lines.push('   → この点検結果は、その情報源ぶんが抜けた状態のものです。');
    lines.push('      （同期では、落ちた情報源ぶんの予定はカレンダーに残します）');
  }

  const unreachable = unreachableIndicators_(true);
  if (unreachable.length) {
    lines.push('');
    lines.push('■ カレンダーに出しようがない指標');
    unreachable.forEach(function (row) { lines.push('   ' + row); });
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
  const fredCount = INDICATORS.filter(function (i) { return i.fred_release; }).length;
  if (!prop_(PROP_FRED_KEY)) {
    lines.push('   1. FRED の無料キーを取得して、スクリプト プロパティ '
               + PROP_FRED_KEY + ' に入れる');
    lines.push('      → ' + fredCount + ' 指標の発表日が公式の確定値になります');
    lines.push('      https://fred.stlouisfed.org/docs/api/api_key.html');
  } else {
    lines.push('   ✅ FRED キーは設定済み');
  }
  if (!CONFIG.providers.officialTimes) {
    lines.push('   2. 00_config.js の providers.officialTimes を true にする');
    lines.push('      → 発表時刻が、機関の予定表そのものになります');
  } else {
    lines.push('   ✅ 発表予定表は有効（時刻の一次情報）');
  }
  if (!CONFIG.providers.investing) {
    lines.push('   3. 00_config.js の providers.investing を true にする');
    lines.push('      → 予想値・前回値・結果値が入ります');
    lines.push('        （予定表に載らない指標は、発表時刻もここから入ります）');
  } else {
    lines.push('   ✅ Investing は有効（予想値・前回値・結果値が入ります）');
  }
  lines.push('   4. checkOfficialTimes() で、発表予定表が読めているかを確かめられます');
  lines.push('   5. verifyRules() を実行すると、発表規則の当たり具合が測れます');

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

/**
 * 自動実行を仕掛ける。人が押す操作なので、失敗はそのまま知らせる。
 * ここで黙って握りつぶすと、「設定したつもりで動いていない」という
 * いちばん気づきにくい状態になる。
 */
function installTriggers() {
  uninstall();
  [CONFIG.triggers.morningHour, CONFIG.triggers.eveningHour].forEach(function (hour) {
    // lint-ok: 失敗はそのまま知らせる（設定したつもりで動いていない、を避ける）
    ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyDays(1).atHour(hour).create();
  });
  log_('自動実行を設定しました（毎日 '
       + CONFIG.triggers.morningHour + '時 / ' + CONFIG.triggers.eveningHour + '時ごろ）');
}

/** 自動実行を止める。これも人が押す操作なので、失敗はそのまま知らせる。 */
function uninstall() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {   // lint-ok: 同上
    if (trigger.getHandlerFunction() === TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);   // lint-ok: 同上
      removed++;
    }
  });
  if (removed) log_('既存の自動実行 ' + removed + ' 件を解除しました');
  return removed;
}

function countTriggers_() {
  // showStatus から呼ばれる。困ったときに見る画面なので、ここで落ちない。
  try {
    return ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === TRIGGER_HANDLER;
    }).length;
  } catch (err) {
    log_('自動実行の一覧を取得できませんでした: ' + err);
    return -1;
  }
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
