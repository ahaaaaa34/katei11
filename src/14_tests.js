/**
 * GAS 上での自己テスト。エディタで runTests を選んで実行してください。
 *
 * 開発用の網羅的なテストは tests/run.js（Node）にあります。ここにあるのは
 * 「この Google アカウント・この実行環境で本当に動くか」を確かめるための
 * 最小限。特に Intl（夏時間の計算）と Calendar 拡張サービスの有無を見ます。
 */

function runTests() {
  const results = [];

  function check(name, body) {
    try {
      body();
      results.push('✅ ' + name);
    } catch (err) {
      results.push('❌ ' + name + '\n     ' + err.message);
    }
  }

  function eq(actual, expected, hint) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error((hint ? hint + ' / ' : '') +
        '期待 ' + JSON.stringify(expected) + ' 実際 ' + JSON.stringify(actual));
    }
  }

  check('実行環境が Intl のタイムゾーンを扱える', function () {
    const parts = tzParts_(new Date(Date.UTC(2026, 8, 10, 12, 30)), ET);
    eq([parts.hour, parts.minute], [8, 30]);
  });

  check('夏時間が正しく処理される', function () {
    eq(zonedTime_(ymd_(2026, 7, 10), '08:30', ET).toISOString(), '2026-07-10T12:30:00.000Z');
    eq(zonedTime_(ymd_(2026, 12, 10), '08:30', ET).toISOString(), '2026-12-10T13:30:00.000Z');
  });

  check('8:30 ET が 21:30 JST になる', function () {
    eq(formatClock_(zonedTime_(ymd_(2026, 9, 10), '08:30', ET), 'Asia/Tokyo').time, '21:30');
  });

  check('SHA-1 が既知のテストベクタと一致する', function () {
    eq(sha1Hex_('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    eq(sha1Hex_('米 消費者物価指数'), '3564fa5ab71da9d9d4871a305429a3667313b8e5');
  });

  check('予定 ID が固定値どおりに出る（既存予定を作り直さないため）', function () {
    const start = new Date(Date.UTC(2026, 8, 10, 12, 30));
    const event = makeEvent_({ indicatorId: 'us_cpi', title: 'CPI', start: start,
                               end: new Date(start.getTime() + 1800000), impact: 98 });
    eq(eventCalendarId_(event, 'UTC'), 'ec74voedqjm1fii6oh3gegok6lm7bf8smv');
  });

  check('祝日カレンダー', function () {
    eq(!!marketHolidays_(2026)['2026-04-03'], true, 'グッドフライデーは休場');
    eq(!!federalHolidays_(2026)['2026-04-03'], false, '役所は開いている');
    eq(marketEarlyCloses_(2026)['2026-11-27'], '感謝祭翌日');
  });

  check('繰り返しルール', function () {
    eq(ruleDates_({ type: 'nth_business_day', n: 1 }, ymd_(2026, 11, 1), ymd_(2026, 11, 30))
       .map(dateKey_), ['2026-11-02']);
    eq(ruleDates_({ type: 'weekly', weekday: 'thu' }, ymd_(2026, 11, 20), ymd_(2026, 11, 30))
       .map(dateKey_), ['2026-11-25'], '感謝祭の週は木曜から水曜へ前倒し');
  });

  check('指標カタログが読める', function () {
    eq(INDICATORS.length > 30, true);
    eq(indicator_('us_cpi').impact >= 90, true);
    eq(matchEventName_('Core CPI (MoM) (Aug)').id, 'us_cpi');
  });

  check('通信なしで1か月ぶんの予定が組める', function () {
    const saved = JSON.parse(JSON.stringify(CONFIG.providers));
    CONFIG.providers.fred = false;
    CONFIG.providers.earnings = false;
    CONFIG.providers.investing = false;
    try {
      const events = collectEvents_({ start: ymd_(2026, 9, 1), end: ymd_(2026, 9, 30),
                                      timezone: 'Asia/Tokyo' });
      eq(events.length >= 20, true, '件数 ' + events.length);
      const ids = events.map(function (e) { return e.indicatorId; });
      ['us_cpi', 'us_nfp', 'us_fomc_rate'].forEach(function (id) {
        eq(ids.indexOf(id) !== -1, true, id + ' が無い');
      });
    } finally {
      Object.keys(saved).forEach(function (k) { CONFIG.providers[k] = saved[k]; });
    }
  });

  check('Calendar 拡張サービスが有効になっている', function () {
    if (typeof Calendar === 'undefined' || !Calendar.Events) {
      throw new Error('エディタ左の [サービス] から Calendar API を追加してください');
    }
    Calendar.CalendarList.list({ maxResults: 1 });
  });

  check('タイムゾーン設定が CONFIG と一致している', function () {
    const scriptTz = Session.getScriptTimeZone();
    if (scriptTz !== CONFIG.timezone) {
      throw new Error('スクリプトのタイムゾーンは ' + scriptTz + ' ですが CONFIG は '
                      + CONFIG.timezone + ' です。トリガーの実行時刻がずれます。'
                      + '[プロジェクトの設定] で合わせてください。');
    }
  });

  const text = results.join('\n');
  log_(text);
  return text;
}
