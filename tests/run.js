/**
 * テスト本体。`npm test` または `node tests/run.js` で実行する。
 * ネットワークには一切出ない（HTTP はスタブが例外を投げる）。
 */

const { loadGas, fakeCalendar, fakeScriptApp } = require('./harness');
const { suite, test, eq, ok, throws, report } = require('./assert');

const G = loadGas();
const K = G.dateKey_;
const Y = G.ymd_;
const keys = (dates) => dates.map(K);

function offlineConfig(api, patch) {
  api.CONFIG.providers.fred = false;
  api.CONFIG.providers.earnings = false;
  api.CONFIG.providers.investing = false;
  if (patch) patch(api.CONFIG);
  return api.CONFIG;
}

function event(api, over = {}) {
  const start = over.start || new Date(Date.UTC(2026, 8, 10, 12, 30));
  return api.makeEvent_(Object.assign({
    indicatorId: 'us_cpi',
    title: 'テスト指標',
    start,
    end: over.end || new Date(start.getTime() + 30 * 60000),
    impact: 90,
  }, over));
}

// ---------------------------------------------------------------------------
suite('SHA-1 と予定 ID', () => {
  test('既知のテストベクタと一致する', () => {
    eq(G.sha1Hex_('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    eq(G.sha1Hex_(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
    eq(G.sha1Hex_('The quick brown fox jumps over the lazy dog'),
       '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12');
    eq(G.sha1Hex_('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
       '84983e441c3bd26ebaae4aa1f95129e5e54670f1');
  });

  test('マルチバイト文字を UTF-8 として扱う', () => {
    eq(G.sha1Hex_('米 消費者物価指数'), '3564fa5ab71da9d9d4871a305429a3667313b8e5');
  });

  test('予定 ID は Google が許す文字だけを使う', () => {
    const id = G.eventCalendarId_(event(G), 'Asia/Tokyo');
    ok(/^[a-v0-9]{5,1024}$/.test(id), '不正な ID: ' + id);
  });

  test('予定 ID は指標と日付で決まる（作り直しを防ぐ固定値）', () => {
    eq(G.eventCalendarId_(event(G), 'UTC'), 'ec74voedqjm1fii6oh3gegok6lm7bf8smv');
  });

  test('指標か日付が違えば ID も違う', () => {
    const a = G.eventCalendarId_(event(G), 'Asia/Tokyo');
    const b = G.eventCalendarId_(event(G, { indicatorId: 'us_ppi' }), 'Asia/Tokyo');
    const c = G.eventCalendarId_(
      event(G, { start: new Date(Date.UTC(2026, 8, 11, 12, 30)) }), 'Asia/Tokyo');
    eq(new Set([a, b, c]).size, 3);
  });
});

// ---------------------------------------------------------------------------
suite('タイムゾーン', () => {
  test('夏時間と冬時間で ET のずれが変わる', () => {
    eq(G.zonedTime_(Y(2026, 7, 10), '08:30', 'America/New_York').toISOString(),
       '2026-07-10T12:30:00.000Z');
    eq(G.zonedTime_(Y(2026, 12, 10), '08:30', 'America/New_York').toISOString(),
       '2026-12-10T13:30:00.000Z');
  });

  test('夏時間の切替日でも正しい時刻になる', () => {
    // 2026-03-08 が米国の切替日。8:30 はすでに EDT。
    eq(G.zonedTime_(Y(2026, 3, 8), '08:30', 'America/New_York').toISOString(),
       '2026-03-08T12:30:00.000Z');
    eq(G.zonedTime_(Y(2026, 3, 7), '08:30', 'America/New_York').toISOString(),
       '2026-03-07T13:30:00.000Z');
  });

  test('日本時間へ変換すると 8:30 ET は 21:30 JST', () => {
    const instant = G.zonedTime_(Y(2026, 9, 10), '08:30', 'America/New_York');
    eq(G.formatClock_(instant, 'Asia/Tokyo').time, '21:30');
  });

  test('表示日はタイムゾーンで変わる', () => {
    const late = G.zonedTime_(Y(2026, 9, 10), '22:00', 'America/New_York');
    eq(K(G.localDate_(late, 'America/New_York')), '2026-09-10');
    eq(K(G.localDate_(late, 'Asia/Tokyo')), '2026-09-11');
  });
});

// ---------------------------------------------------------------------------
suite('米国カレンダー', () => {
  test('復活祭の計算', () => {
    eq(K(G.easter_(2024)), '2024-03-31');
    eq(K(G.easter_(2025)), '2025-04-20');
    eq(K(G.easter_(2026)), '2026-04-05');
  });

  test('グッドフライデーは市場だけ休み', () => {
    ok(G.marketHolidays_(2026)['2026-04-03']);
    ok(!G.federalHolidays_(2026)['2026-04-03']);
  });

  test('コロンブスデーは役所だけ休み', () => {
    ok(G.federalHolidays_(2026)['2026-10-12']);
    ok(!G.marketHolidays_(2026)['2026-10-12']);
  });

  test('土曜の祝日は前日の金曜が休場になる', () => {
    ok(G.marketHolidays_(2026)['2026-07-03']);
    ok(!G.marketEarlyCloses_(2026)['2026-07-03'], '休場日は短縮取引にしない');
  });

  test('元日が土曜のときは前日の金曜を休場にしない', () => {
    ok(!G.marketHolidays_(2021)['2021-12-31']);
    ok(G.marketHolidays_(2027)['2027-01-01']);
  });

  test('感謝祭翌日は半日', () => {
    eq(G.marketEarlyCloses_(2026)['2026-11-27'], '感謝祭翌日');
  });
});

// ---------------------------------------------------------------------------
suite('繰り返しルール', () => {
  test('第 n 営業日', () => {
    eq(keys(G.ruleDates_({ type: 'nth_business_day', n: 3 }, Y(2026, 9, 1), Y(2026, 9, 30))),
       ['2026-09-03']);
    eq(keys(G.ruleDates_({ type: 'nth_business_day', n: 1 }, Y(2026, 11, 1), Y(2026, 11, 30))),
       ['2026-11-02'], '11/1 は日曜なので翌営業日');
  });

  test('最終営業日', () => {
    eq(keys(G.ruleDates_({ type: 'nth_business_day', n: -1 }, Y(2026, 11, 1), Y(2026, 11, 30))),
       ['2026-11-30']);
  });

  test('第 n 曜日と最終曜日', () => {
    eq(keys(G.ruleDates_({ type: 'nth_weekday', weekday: 'fri', n: 1 },
                         Y(2026, 9, 1), Y(2026, 10, 31))),
       ['2026-09-04', '2026-10-02']);
    eq(keys(G.ruleDates_({ type: 'nth_weekday', weekday: 'tue', n: -1 },
                         Y(2026, 9, 1), Y(2026, 9, 30))),
       ['2026-09-29']);
  });

  test('毎週の指標は祝日の週に前倒しされる', () => {
    const got = keys(G.ruleDates_({ type: 'weekly', weekday: 'thu' },
                                  Y(2026, 11, 20), Y(2026, 11, 30)));
    ok(got.indexOf('2026-11-25') !== -1, '感謝祭の週は水曜へ');
    ok(got.indexOf('2026-11-26') === -1);
  });

  test('固定日は休日なら翌営業日へずれる', () => {
    eq(keys(G.ruleDates_({ type: 'day_of_month', day: 12 }, Y(2026, 9, 1), Y(2026, 9, 30))),
       ['2026-09-14'], '9/12 は土曜');
  });

  test('months で対象月を絞れる', () => {
    const got = G.ruleDates_({ type: 'nth_business_day', n: 1, months: [1, 4] },
                             Y(2026, 1, 1), Y(2026, 12, 31));
    eq(got.map((d) => d.getUTCMonth() + 1), [1, 4]);
  });

  test('未知の種別は例外になる', () => {
    throws(() => G.ruleDates_({ type: 'phase_of_moon' }, Y(2026, 1, 1), Y(2026, 2, 1)),
           '未知のスケジュール種別');
  });
});

// ---------------------------------------------------------------------------
suite('指標カタログ', () => {
  test('件数と id の一意性', () => {
    ok(G.INDICATORS.length > 30);
    eq(new Set(G.INDICATORS.map((i) => i.id)).size, G.INDICATORS.length);
  });

  test('すべての指標に説明とまともなスコアがある', () => {
    G.INDICATORS.forEach((indicator) => {
      ok(indicator.impact >= 0 && indicator.impact <= 100, indicator.id);
      ok(indicator.why && indicator.why.trim(), indicator.id + ' に why がない');
      ok(indicator.category, indicator.id);
    });
  });

  test('ルールを持つ指標は有効な種別と時刻を持つ', () => {
    const valid = ['nth_business_day', 'nth_weekday', 'day_of_month', 'weekly', 'none'];
    G.INDICATORS.forEach((indicator) => {
      const kind = (indicator.schedule && indicator.schedule.type) || 'none';
      ok(valid.indexOf(kind) !== -1, indicator.id + ': ' + kind);
      if (kind !== 'none') {
        ok(indicator.time || indicator.all_day, indicator.id + ' に time がない');
        ok(/^\d{1,2}:\d{2}$/.test(indicator.time || '00:00'), indicator.id);
      }
    });
  });

  test('主要指標が最上位ランクにいる', () => {
    ['us_cpi', 'us_nfp', 'us_fomc_rate', 'us_pce'].forEach((id) => {
      ok(G.indicator_(id).impact >= 90, id);
    });
  });

  test('イベント名の名寄せは具体的なパターンを優先する', () => {
    eq(G.matchEventName_('Core CPI (MoM) (Aug)').id, 'us_cpi');
    eq(G.matchEventName_('ISM Non-Manufacturing PMI').id, 'us_ism_services');
    eq(G.matchEventName_('Fed Chair Powell Speaks').id, 'us_fed_speech');
    eq(G.matchEventName_('Belgian Bread Price Index'), null);
  });

  test('FRED の release 名を指標に対応づける', () => {
    eq(G.matchFredRelease_('Employment Situation').id, 'us_nfp');
    eq(G.matchFredRelease_('Consumer Price Index').id, 'us_cpi');
  });

  test('FOMC 日程は年8回・SEP は4回', () => {
    const meetings = G.MEETINGS.fomc.meetings;
    eq(meetings.length, 8);
    eq(meetings.filter((m) => m.sep).length, 4);
    const dates = meetings.map((m) => m.date);
    eq(dates, dates.slice().sort(), '日付順に並んでいること');
  });

  test('対象期間のラベル', () => {
    eq(G.periodLabel_(Y(2026, 9, 14), -1), '2026年8月分');
    eq(G.periodLabel_(Y(2027, 1, 10), -2), '2026年11月分');
    eq(G.periodLabel_(Y(2026, 9, 14), 0), null);
  });
});

// ---------------------------------------------------------------------------
suite('イベントの合成', () => {
  test('上位の情報源が日時を決める', () => {
    const guess = event(G, { source: 'rules', estimated: true,
                             start: new Date(Date.UTC(2026, 8, 10, 13, 0)) });
    const official = event(G, { source: 'fred', estimated: false });
    const merged = G.mergeEvent_(guess, official);
    eq(merged.source, 'fred');
    eq(merged.start.toISOString(), '2026-09-10T12:30:00.000Z');
  });

  test('下位の情報源から空欄の数値を埋める', () => {
    const official = event(G, { source: 'fred' });
    const scraped = event(G, { source: 'investing', forecast: '0.3%',
                               previous: '0.2%', actual: '0.4%' });
    const merged = G.mergeEvent_(official, scraped);
    eq(merged.source, 'fred');
    eq([merged.forecast, merged.previous, merged.actual], ['0.3%', '0.2%', '0.4%']);
  });

  test('合成は順序に依らない', () => {
    const a = event(G, { source: 'rules', estimated: true, note: 'なぜ効くか' });
    const b = event(G, { source: 'investing', forecast: '1.0%' });
    eq(G.eventContentHash_(G.mergeEvent_(a, b)), G.eventContentHash_(G.mergeEvent_(b, a)));
  });

  test('確定日は下位の情報源から来ても推定日に勝つ', () => {
    const estimatedHigh = event(G, { source: 'investing', estimated: true,
                                     start: new Date(Date.UTC(2026, 8, 10, 16, 0)) });
    const confirmedLow = event(G, { source: 'rules', estimated: false });
    const merged = G.mergeEvent_(estimatedHigh, confirmedLow);
    eq(merged.estimated, false);
    eq(merged.start.toISOString(), '2026-09-10T12:30:00.000Z');
  });

  test('内容ハッシュは表示に使う値だけを見る', () => {
    eq(G.eventContentHash_(event(G)), G.eventContentHash_(event(G)));
    ok(G.eventContentHash_(event(G)) !== G.eventContentHash_(event(G, { forecast: '0.3%' })));
  });

  test('start/end の不正は弾く', () => {
    throws(() => G.makeEvent_({ indicatorId: 'x', title: 'x', impact: 1,
                                start: '2026-01-01', end: '2026-01-01' }), 'Date');
    throws(() => G.makeEvent_({ indicatorId: 'x', title: 'x', impact: 1,
                                start: new Date(2), end: new Date(1) }), 'end');
  });
});

// ---------------------------------------------------------------------------
suite('情報源', () => {
  const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };

  test('ルール計算が主要指標を正しい日に置く', () => {
    const byId = {};
    G.providerRules_(ctx).forEach((e) => { byId[e.indicatorId] = e; });
    eq(K(G.localDate_(byId.us_ism_mfg.start, 'America/New_York')), '2026-09-01');
    eq(K(G.localDate_(byId.us_nfp.start, 'America/New_York')), '2026-09-04');
  });

  test('確定ルールと概算ルールを区別する', () => {
    const byId = {};
    G.providerRules_(ctx).forEach((e) => { byId[e.indicatorId] = e; });
    eq(byId.us_ism_mfg.estimated, false, '第1営業日は確定');
    eq(byId.us_cpi.estimated, true, '日付は概算');
  });

  test('対象期間のラベルが入る', () => {
    const cpi = G.providerRules_(ctx).find((e) => e.indicatorId === 'us_cpi');
    eq(cpi.period, '2026年8月分');
  });

  test('範囲外の日付を返さない', () => {
    G.providerRules_(ctx).forEach((e) => {
      const day = G.localDate_(e.start, 'America/New_York');
      ok(day >= ctx.start && day <= ctx.end, e.indicatorId);
    });
  });

  test('FOMC 会合から記者会見まで展開される', () => {
    const ids = new Set(G.providerFomc_(ctx).map((e) => e.indicatorId));
    ok(ids.has('us_fomc_rate') && ids.has('us_fomc_presser'));
  });

  test('議事要旨は3週間後、ベージュブックは2週間前', () => {
    const oct = { start: Y(2026, 10, 1), end: Y(2026, 10, 31), timezone: 'Asia/Tokyo' };
    const minutes = G.providerFomc_(oct).find((e) => e.indicatorId === 'us_fomc_minutes');
    eq(K(G.localDate_(minutes.start, 'America/New_York')), '2026-10-07');
    ok(minutes.period.indexOf('9月16日会合分') !== -1, minutes.period);
    const beige = G.providerFomc_(ctx).find((e) => e.indicatorId === 'us_beige_book');
    eq(K(G.localDate_(beige.start, 'America/New_York')), '2026-09-02');
  });

  test('SEP 回には注記が付く', () => {
    const rate = G.providerFomc_(ctx).find((e) => e.indicatorId === 'us_fomc_rate');
    eq(rate.extra.sep, true);
    ok(rate.note.indexOf('ドットチャート') !== -1);
  });

  test('FOMC 由来のイベントは推定ではない', () => {
    G.providerFomc_(ctx).forEach((e) => eq(e.estimated, false, e.indicatorId));
  });

  test('休場は終日イベントになる', () => {
    const holiday = G.providerMarket_(ctx).find((e) => e.indicatorId === 'market_holiday');
    ok(holiday.allDay);
    ok(holiday.title.indexOf('レイバーデー') !== -1);
  });

  test('SQ は四半期末の月だけ、OPEX はそれ以外の8か月', () => {
    const year = { start: Y(2026, 1, 1), end: Y(2026, 12, 31), timezone: 'Asia/Tokyo' };
    const events = G.providerMarket_(year);
    const quads = events.filter((e) => e.indicatorId === 'market_quad_witching');
    eq([...new Set(quads.map((e) => e.start.getUTCMonth() + 1))].sort((a, b) => a - b),
       [3, 6, 9, 12]);
    eq(events.filter((e) => e.indicatorId === 'market_opex').length, 8);
  });

  test('FRED はキーが無ければ静かに諦める', () => {
    eq(G.providerFred_(ctx), []);
  });

  test('FRED の応答を指標に対応づける', () => {
    const api = loadGas({
      properties: { FRED_API_KEY: 'dummy' },
      UrlFetchApp: {
        fetch: () => ({
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            count: 2,
            release_dates: [
              { release_id: 10, release_name: 'Consumer Price Index', date: '2026-09-11' },
              { release_id: 99, release_name: 'Cheese Price Index', date: '2026-09-11' },
            ],
          }),
        }),
      },
    });
    const events = api.providerFred_(ctx);
    eq(events.map((e) => e.indicatorId), ['us_cpi']);
    eq(K(api.localDate_(events[0].start, 'America/New_York')), '2026-09-11');
    eq(events[0].estimated, false, '公式日付なので推定ではない');
    eq(api.formatClock_(events[0].start, 'America/New_York').time, '08:30', '時刻はカタログから');
  });

  test('FRED が落ちても例外を投げない', () => {
    const api = loadGas({
      properties: { FRED_API_KEY: 'dummy' },
      UrlFetchApp: { fetch: () => { throw new Error('network down'); } },
    });
    eq(api.providerFred_(ctx), []);
  });

  test('Investing の HTML から数値を取り出す', () => {
    const html = '<tr id="eventRowId_733" data-event-datetime="2026/09/11 12:30:00">'
      + '<td class="first left time js-time">12:30</td>'
      + '<td class="left event"><a href="/economic-calendar/cpi-733">'
      + 'Core CPI (MoM)&nbsp;<span>(Aug)</span></a></td>'
      + '<td class="bold greenFont" id="eventActual_733">0.2%</td>'
      + '<td id="eventForecast_733">0.3%</td>'
      + '<td id="eventPrevious_733">0.4%</td></tr>';
    const rows = G.parseInvestingRows_(html);
    eq(rows.length, 1);
    eq(rows[0].name, 'Core CPI (MoM) (Aug)');
    eq([rows[0].actual, rows[0].forecast, rows[0].previous], ['0.2%', '0.3%', '0.4%']);

    const events = G.investingRowsToEvents_(rows, ctx);
    eq(events[0].indicatorId, 'us_cpi');
    eq(events[0].period, 'Aug');
    eq(K(G.localDate_(events[0].start, 'Asia/Tokyo')), '2026-09-11');
  });

  test('Investing の想定外マークアップは黙って飛ばす', () => {
    eq(G.parseInvestingRows_('<tr><td class="weird"><div>???</div></td></tr>').length, 0);
  });

  test('カタログに無いイベントは捨てる', () => {
    const rows = [{ datetime: '2026/09/11 12:30:00', name: 'Latvian Tractor Output' }];
    eq(G.investingRowsToEvents_(rows, ctx), []);
  });

  test('決算は設定した銘柄だけを拾う', () => {
    const e = G.earningsEvent_(Y(2026, 10, 29),
      { symbol: 'AAPL', name: 'Apple', time: 'time-after-hours', epsForecast: '$1.60' },
      { AAPL: 88 });
    eq(e.impact, 88);
    ok(e.title.indexOf('引け後') !== -1);
    eq(G.formatClock_(e.start, 'America/New_York').time, '16:15');
    eq(G.earningsEvent_(Y(2026, 10, 29), { symbol: 'XYZ' }, { AAPL: 88 }), null);
  });

  test('寄り前の決算は 07:00 ET', () => {
    const e = G.earningsEvent_(Y(2026, 10, 29),
      { symbol: 'AAPL', time: 'time-pre-market' }, { AAPL: 88 });
    eq(G.formatClock_(e.start, 'America/New_York').time, '07:00');
    ok(e.title.indexOf('寄り前') !== -1);
  });
});

// ---------------------------------------------------------------------------
suite('突き合わせと選抜', () => {
  test('同じ発表をひとつにまとめる', () => {
    const merged = G.mergeEvents_([
      event(G, { source: 'rules', estimated: true }),
      event(G, { source: 'fred' }),
      event(G, { source: 'investing', forecast: '0.3%' }),
    ], 'Asia/Tokyo');
    eq(merged.length, 1);
    eq(merged[0].source, 'fred');
    eq(merged[0].forecast, '0.3%');
  });

  test('近くに確定日が出たら推定日を捨てる', () => {
    const guess = event(G, { source: 'rules', estimated: true,
                             start: G.zonedTime_(Y(2026, 9, 14), '08:30', 'America/New_York') });
    const confirmed = event(G, { source: 'fred',
                                 start: G.zonedTime_(Y(2026, 9, 11), '08:30', 'America/New_York') });
    const kept = G.dropSupersededEstimates_([guess, confirmed], 'Asia/Tokyo');
    eq(kept.length, 1);
    eq(kept[0].source, 'fred');
  });

  test('月をまたぐ同一指標は別の発表として両方残す', () => {
    const guess = event(G, { source: 'rules', estimated: true,
                             start: G.zonedTime_(Y(2026, 10, 14), '08:30', 'America/New_York') });
    const confirmed = event(G, { source: 'fred',
                                 start: G.zonedTime_(Y(2026, 9, 11), '08:30', 'America/New_York') });
    eq(G.dropSupersededEstimates_([guess, confirmed], 'Asia/Tokyo').length, 2);
  });

  test('週次の指標は間引かれない', () => {
    const weekly = [3, 10, 17].map((day) => event(G, {
      indicatorId: 'us_jobless_claims',
      start: G.zonedTime_(Y(2026, 9, day), '08:30', 'America/New_York'),
    }));
    eq(G.dropSupersededEstimates_(weekly, 'Asia/Tokyo').length, 3);
  });

  test('影響度のしきい値で絞る', () => {
    const api = loadGas();
    api.CONFIG.filter.minImpact = 55;
    const kept = api.applyFilter_([event(api, { impact: 95 }),
                                   event(api, { indicatorId: 'low', impact: 40 })]);
    eq(kept.map((e) => e.impact), [95]);
  });

  test('include はしきい値を上書きし、exclude が最優先', () => {
    const api = loadGas();
    api.CONFIG.filter.include = ['low'];
    eq(api.applyFilter_([event(api, { indicatorId: 'low', impact: 10 })]).length, 1);
    api.CONFIG.filter.exclude = ['low'];
    eq(api.applyFilter_([event(api, { indicatorId: 'low', impact: 10 })]).length, 0);
  });

  test('国とカテゴリで絞れる', () => {
    const api = loadGas();
    api.CONFIG.filter.countries = ['US'];
    api.CONFIG.filter.categories = ['inflation'];
    const kept = api.applyFilter_([
      event(api, { indicatorId: 'a', country: 'US', category: 'inflation' }),
      event(api, { indicatorId: 'b', country: 'JP', category: 'inflation' }),
      event(api, { indicatorId: 'c', country: 'US', category: 'housing' }),
    ]);
    eq(kept.map((e) => e.indicatorId), ['a']);
  });

  test('通信なしでも1か月ぶんの実用的な予定表になる', () => {
    const api = loadGas();
    offlineConfig(api);
    const events = api.collectEvents_({ start: Y(2026, 9, 1), end: Y(2026, 9, 30),
                                        timezone: 'Asia/Tokyo' });
    const ids = new Set(events.map((e) => e.indicatorId));
    ['us_cpi', 'us_nfp', 'us_fomc_rate', 'us_ism_mfg'].forEach((id) => ok(ids.has(id), id));
    ok(events.length >= 20, '件数: ' + events.length);
  });

  test('壊れた情報源があっても同期は続く', () => {
    const api = loadGas({ properties: { FRED_API_KEY: 'x' },
                          UrlFetchApp: { fetch: () => { throw new Error('boom'); } } });
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    ok(api.collectEvents_({ start: Y(2026, 9, 1), end: Y(2026, 9, 30),
                            timezone: 'Asia/Tokyo' }).length > 0);
  });

  test('時刻順・影響度順に並ぶ', () => {
    const api = loadGas();
    api.CONFIG.providers = { rules: false, fomc: false, market: false,
                             fred: false, earnings: false, investing: false };
    const events = api.collectEvents_({ start: Y(2026, 9, 1), end: Y(2026, 9, 30),
                                        timezone: 'Asia/Tokyo' });
    eq(events, []);
  });

  test('同期期間は設定どおりに決まる', () => {
    const api = loadGas();
    api.CONFIG.window = { daysBack: 3, daysAhead: 30 };
    const w = api.syncWindow_(Y(2026, 9, 9));
    eq([K(w.start), K(w.end)], ['2026-09-06', '2026-10-09']);
  });
});

// ---------------------------------------------------------------------------
suite('カレンダーへの反映', () => {
  function stored(api, ev) {
    const resource = api.toCalendarResource_(ev);
    return { id: resource.id, summary: resource.summary,
             extendedProperties: { private: { ecal: '1',
               hash: api.eventContentHash_(ev) } } };
  }

  function withCalendar(seed) {
    const calendar = fakeCalendar(seed);
    const api = loadGas({ Calendar: calendar,
                          properties: { _calendarId: 'cal-123' } });
    offlineConfig(api);
    return { api, calendar };
  }

  test('管理用の目印と「予定なし」扱いを付ける', () => {
    const resource = G.toCalendarResource_(event(G));
    eq(resource.extendedProperties.private.ecal, '1');
    eq(resource.transparency, 'transparent');
  });

  test('終日イベントは日付だけを持つ', () => {
    const resource = G.toCalendarResource_(event(G, { allDay: true, impact: 60 }));
    eq(Object.keys(resource.start), ['date']);
    ok(resource.end.date > resource.start.date);
  });

  test('通知はランクごとに変わる', () => {
    eq(G.toCalendarResource_(event(G, { impact: 98 })).reminders.overrides
        .map((r) => r.minutes), [1440, 30]);
    eq(G.toCalendarResource_(event(G, { impact: 60 })).reminders.overrides, []);
  });

  test('通知は Google の上限までに切り詰める', () => {
    const api = loadGas();
    api.CONFIG.reminders.S = [1, 2, 3, 4, 5, 6, 7];
    eq(api.toCalendarResource_(event(api, { impact: 95 })).reminders.overrides.length, 5);
  });

  test('新規は作成される', () => {
    const { api, calendar } = withCalendar();
    const plan = api.applyPlan_(api.buildPlan_('cal-123', [event(api)], []));
    eq(plan.created.length, 1);
    eq(calendar.calls.filter((c) => c[0] === 'events.insert').length, 1);
  });

  test('内容が同じなら API を叩かない', () => {
    const ev = event(G);
    const { api, calendar } = withCalendar();
    const plan = api.applyPlan_(api.buildPlan_('cal-123', [ev], [stored(api, ev)]));
    eq([plan.created.length, plan.updated.length, plan.deleted.length], [0, 0, 0]);
    eq(plan.unchanged.length, 1);
    eq(calendar.calls.filter((c) => c[0].indexOf('events.') === 0).length, 0);
  });

  test('数値が付いたら重複ではなく更新になる', () => {
    const { api } = withCalendar();
    const before = event(api);
    const after = event(api, { actual: '0.4%' });
    const stale = stored(api, before);
    stale.extendedProperties.private.hash = 'stale';
    const plan = api.buildPlan_('cal-123', [after], [stale]);
    eq(plan.updated.length, 1);
    eq(plan.created.length, 0);
  });

  test('選ばれなくなった予定は削除される', () => {
    const { api, calendar } = withCalendar();
    const orphan = stored(api, event(api, { indicatorId: 'us_old' }));
    const plan = api.applyPlan_(api.buildPlan_('cal-123', [], [orphan]));
    eq(plan.deleted.length, 1);
    eq(calendar.calls.filter((c) => c[0] === 'events.remove').length, 1);
  });

  test('発表日が動いたら移動になる（重複しない）', () => {
    const { api } = withCalendar();
    const oldEvent = event(api, {
      start: api.zonedTime_(Y(2026, 9, 14), '08:30', 'America/New_York'), estimated: true });
    const newEvent = event(api, {
      start: api.zonedTime_(Y(2026, 9, 11), '08:30', 'America/New_York') });
    const plan = api.buildPlan_('cal-123', [newEvent], [stored(api, oldEvent)]);
    eq([plan.created.length, plan.deleted.length], [1, 1]);
  });

  test('ID 重複で失敗したら更新にフォールバックする', () => {
    const ev = event(G);
    const id = G.eventCalendarId_(ev, 'Asia/Tokyo');
    const { api, calendar } = withCalendar({ failInsertOnce: id });
    api.applyPlan_(api.buildPlan_('cal-123', [ev], []));
    ok(calendar.calls.some((c) => c[0] === 'events.update' && c[1] === id));
  });

  test('既に消えている予定の削除は成功扱い', () => {
    const orphan = stored(G, event(G, { indicatorId: 'us_old' }));
    const { api } = withCalendar({ missingOnRemove: [orphan.id] });
    api.applyPlan_(api.buildPlan_('cal-123', [], [orphan]));  // 例外が出なければ合格
  });

  test('409 以外の失敗は握りつぶさない', () => {
    const calendar = fakeCalendar();
    calendar.Events.insert = () => { throw new Error('Invalid value for field summary'); };
    const api = loadGas({ Calendar: calendar, properties: { _calendarId: 'cal-123' } });
    throws(() => api.applyPlan_(api.buildPlan_('cal-123', [event(api)], [])), 'Invalid value');
  });

  test('2回目の同期は何もしない（冪等）', () => {
    const { api, calendar } = withCalendar();
    const events = api.collectEvents_({ start: Y(2026, 9, 1), end: Y(2026, 9, 30),
                                        timezone: 'Asia/Tokyo' });
    api.applyPlan_(api.buildPlan_('cal-123', events, []));
    const existing = [...calendar.events.values()];
    eq(existing.length, events.length);

    calendar.calls.length = 0;
    const plan = api.applyPlan_(api.buildPlan_('cal-123', events, existing));
    eq(api.planChanges_(plan), 0, api.planSummary_(plan));
    eq(calendar.calls.filter((c) => c[0].indexOf('events.') === 0).length, 0);
  });

  test('既存カレンダーを名前で見つけて使い回す', () => {
    const calendar = fakeCalendar({
      calendarList: [{ id: 'found@group', summary: '経済指標 (Nasdaq)' }] });
    const api = loadGas({ Calendar: calendar });
    eq(api.resolveCalendarId_(true), 'found@group');
    eq(calendar.calls.filter((c) => c[0] === 'calendars.insert').length, 0);
  });

  test('無ければ作る', () => {
    const calendar = fakeCalendar({ calendarList: [{ id: 'x', summary: '仕事' }] });
    const api = loadGas({ Calendar: calendar });
    const id = api.resolveCalendarId_(true);
    eq(id, 'created-1');
    const created = calendar.calls.find((c) => c[0] === 'calendars.insert')[1];
    eq(created.summary, '経済指標 (Nasdaq)');
    eq(created.timeZone, 'Asia/Tokyo');
  });

  test('create=false なら作らずに失敗する', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    throws(() => api.resolveCalendarId_(false), '見つかりません');
  });
});

// ---------------------------------------------------------------------------
suite('表示', () => {
  test('件名にランクと国が入る', () => {
    const title = G.renderTitle_(event(G, { impact: 98, title: '米 CPI' }));
    ok(title.indexOf('🔴') === 0 && title.indexOf('米 CPI') !== -1, title);
  });

  test('結果が出たら件名に反映する', () => {
    ok(G.renderTitle_(event(G, { actual: '0.2%' })).indexOf('→ 0.2%') !== -1);
  });

  test('推定日は件名で明示する', () => {
    ok(G.renderTitle_(event(G, { estimated: true })).indexOf('予定日未確定') !== -1);
  });

  test('結果が出れば「予定日未確定」は消える', () => {
    const title = G.renderTitle_(event(G, { estimated: true, actual: '0.2%' }));
    ok(title.indexOf('予定日未確定') === -1 && title.indexOf('0.2%') !== -1);
  });

  test('説明文に数値・現地時刻・解説が入る', () => {
    const text = G.renderDescription_(event(G, {
      forecast: '0.3%', previous: '0.2%', actual: '0.4%', note: '効き方の説明' }));
    ['予想  0.3%', '前回  0.2%', '結果  0.4%', 'ET)', '効き方の説明', G.MARKER]
      .forEach((needle) => ok(text.indexOf(needle) !== -1, needle));
  });

  test('数値が無ければその欄を出さない', () => {
    ok(G.renderDescription_(event(G)).indexOf('予想') === -1);
  });

  test('推定日は説明文でも警告する', () => {
    ok(G.renderDescription_(event(G, { estimated: true })).indexOf('推定') !== -1);
  });

  test('星の数', () => {
    eq([98, 80, 60, 10].map(G.stars_),
       ['★★★★★', '★★★★☆', '★★★☆☆', '★☆☆☆☆']);
  });

  test('表示の切り替えが効く', () => {
    const api = loadGas();
    api.CONFIG.display = { impactEmoji: false, countryFlag: false, showScore: true };
    eq(api.renderTitle_(event(api, { impact: 98, title: '米 CPI' })), '米 CPI [98]');
  });
});

// ---------------------------------------------------------------------------
suite('週次ダイジェスト', () => {
  const ctx = { start: Y(2026, 9, 14), end: Y(2026, 9, 20), timezone: 'Asia/Tokyo' };

  test('重要なものだけを載せる', () => {
    const api = loadGas();
    const events = [
      event(api, { indicatorId: 'a', impact: 98, title: 'CPI',
                   start: api.zonedTime_(Y(2026, 9, 14), '08:30', 'America/New_York') }),
      event(api, { indicatorId: 'b', impact: 60, title: '住宅着工',
                   start: api.zonedTime_(Y(2026, 9, 15), '08:30', 'America/New_York') }),
    ];
    const digests = api.weeklyDigestEvents_(events, ctx);
    eq(digests.length, 1);
    eq(digests[0].indicatorId, api.DIGEST_ID);
    ok(digests[0].allDay);
    ok(digests[0].note.indexOf('CPI') !== -1);
    ok(digests[0].note.indexOf('住宅着工') === -1);
  });

  test('最重要の件数を数える', () => {
    const api = loadGas();
    const events = [1, 2, 3].map((n) => event(api, {
      indicatorId: 'e' + n, impact: 98,
      start: api.zonedTime_(Y(2026, 9, 14), '08:30', 'America/New_York') }));
    ok(api.weeklyDigestEvents_(events, ctx)[0].title.indexOf('最重要 3件') !== -1);
  });

  test('無効にできる', () => {
    const api = loadGas();
    api.CONFIG.digest.weeklyEvent = false;
    eq(api.weeklyDigestEvents_([event(api, { impact: 98 })], ctx), []);
  });

  test('週の途中から始まる範囲では初週を作らない', () => {
    const api = loadGas();
    const partial = { start: Y(2026, 9, 16), end: Y(2026, 9, 20), timezone: 'Asia/Tokyo' };
    const events = [event(api, { impact: 98,
      start: api.zonedTime_(Y(2026, 9, 17), '08:30', 'America/New_York') })];
    eq(api.weeklyDigestEvents_(events, partial), []);
  });

  test('テキスト版は日ごとにまとまる', () => {
    const api = loadGas();
    const text = api.digestText_([
      event(api, { indicatorId: 'a',
                   start: api.zonedTime_(Y(2026, 9, 14), '08:30', 'America/New_York') }),
      event(api, { indicatorId: 'b',
                   start: api.zonedTime_(Y(2026, 9, 15), '08:30', 'America/New_York') }),
    ], ctx);
    ok(text.indexOf('*09/14(月)*') !== -1 && text.indexOf('*09/15(火)*') !== -1, text);
  });

  test('該当なしでも壊れない', () => {
    ok(G.digestText_([], ctx).indexOf('（該当なし）') !== -1);
  });
});

// ---------------------------------------------------------------------------
suite('放置運用の見張り', () => {
  const ctxFar = { start: Y(2026, 6, 1), end: Y(2026, 6, 11), timezone: 'Asia/Tokyo' };

  function findings(api, ctx) {
    const out = {};
    api.maintenanceReport_(ctx).forEach((f) => { out[f.key] = f; });
    return out;
  }

  test('余裕があるうちは静か', () => {
    const api = loadGas({ properties: { FRED_API_KEY: 'dummy' } });
    eq(api.maintenanceReport_(ctxFar), []);
  });

  test('期限が近づくと情報レベルで知らせる', () => {
    const api = loadGas({ properties: { FRED_API_KEY: 'dummy' } });
    const f = findings(api, { start: Y(2026, 9, 4), end: Y(2026, 11, 8) })['meetings:fomc'];
    eq(f.severity, api.SEVERITY_INFO);
    ok(f.message.indexOf('2026-12-09') !== -1);
  });

  test('同期範囲が空白域に入ったら要対応に上げる', () => {
    const api = loadGas({ properties: { FRED_API_KEY: 'dummy' } });
    const report = api.maintenanceReport_({ start: Y(2026, 10, 10), end: Y(2026, 12, 14) });
    eq(report[0].severity, api.SEVERITY_ACTION);
    ok(api.needsAction_(report));
  });

  test('直し方まで書いてある', () => {
    const api = loadGas({ properties: { FRED_API_KEY: 'dummy' } });
    const f = findings(api, { start: Y(2026, 10, 10), end: Y(2026, 12, 14) })['meetings:fomc'];
    ok(f.fix.indexOf('federalreserve.gov') !== -1);
    ok(f.fix.indexOf('02_meetings.js') !== -1);
  });

  test('日銀・ECB の未登録は指摘しない（既定の状態なので）', () => {
    const api = loadGas({ properties: { FRED_API_KEY: 'dummy' } });
    const keysOut = findings(api, { start: Y(2026, 10, 10), end: Y(2026, 12, 14) });
    ok(!keysOut['meetings:boj'] && !keysOut['meetings:ecb']);
  });

  test('FRED キー未設定は情報レベル', () => {
    const api = loadGas();
    const f = findings(api, ctxFar)['provider:fred'];
    eq(f.severity, api.SEVERITY_INFO);
    ok(!api.needsAction_([f]));
  });

  test('要対応はメールで知らせる', () => {
    const api = loadGas({ properties: { FRED_API_KEY: 'dummy' } });
    const report = api.maintenanceReport_({ start: Y(2026, 10, 10), end: Y(2026, 12, 14) });
    eq(api.notifyMaintenance_(report), true);
    eq(api._mail.length, 1);
    ok(api._mail[0].subject.indexOf('メンテナンス') !== -1);
  });

  test('同じ内容を続けて送らない', () => {
    const api = loadGas({ properties: { FRED_API_KEY: 'dummy' } });
    const report = api.maintenanceReport_({ start: Y(2026, 10, 10), end: Y(2026, 12, 14) });
    api.notifyMaintenance_(report);
    eq(api.notifyMaintenance_(report), false, '2回目は抑止される');
    eq(api._mail.length, 1);
  });

  test('情報レベルだけならメールしない', () => {
    const api = loadGas();
    eq(api.notifyMaintenance_(api.maintenanceReport_(ctxFar)), false);
    eq(api._mail.length, 0);
  });

  test('失敗はメールで知らせる', () => {
    const api = loadGas();
    api.notifyFailure_(new Error('boom'));
    eq(api._mail.length, 1);
    ok(api._mail[0].body.indexOf('boom') !== -1);
  });
});

// ---------------------------------------------------------------------------
suite('入口と自動実行', () => {
  test('setup で自動実行が2件入る', () => {
    const scriptApp = fakeScriptApp();
    const api = loadGas({ ScriptApp: scriptApp, Calendar: fakeCalendar() });
    offlineConfig(api);
    const text = api.setup();
    eq(scriptApp._triggers().length, 2);
    eq(scriptApp._triggers().map((t) => t.spec.hour), [6, 20]);
    ok(text.indexOf('セットアップ完了') !== -1);
  });

  test('setup を2回実行してもトリガーは増えない', () => {
    const scriptApp = fakeScriptApp();
    const api = loadGas({ ScriptApp: scriptApp, Calendar: fakeCalendar() });
    offlineConfig(api);
    api.setup();
    api.setup();
    eq(scriptApp._triggers().length, 2);
  });

  test('uninstall で自動実行が消える', () => {
    const scriptApp = fakeScriptApp();
    const api = loadGas({ ScriptApp: scriptApp, Calendar: fakeCalendar() });
    api.installTriggers();
    eq(api.uninstall(), 2);
    eq(scriptApp._triggers().length, 0);
  });

  test('syncCalendar が実際に予定を書き込む', () => {
    const calendar = fakeCalendar();
    const scriptApp = fakeScriptApp();
    const api = loadGas({ Calendar: calendar, ScriptApp: scriptApp });
    offlineConfig(api);
    const plan = api.syncCalendar();
    ok(plan.created.length > 0);
    eq(calendar.events.size, plan.created.length);
  });

  test('0 件なら失敗として扱い、メールで知らせる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    api.CONFIG.providers = { rules: false, fomc: false, market: false,
                             fred: false, earnings: false, investing: false };
    throws(() => api.syncCalendar(), '0 件');
    eq(api._mail.length, 1);
  });

  test('preview はカレンダーに触らない', () => {
    const calendar = fakeCalendar();
    const api = loadGas({ Calendar: calendar });
    offlineConfig(api);
    const text = api.preview();
    ok(text.indexOf('内訳:') !== -1);
    eq(calendar.calls.length, 0);
  });

  test('showStatus が要点を並べる', () => {
    const api = loadGas({ ScriptApp: fakeScriptApp() });
    const text = api.showStatus();
    ['指標カタログ', '有効な情報源', '同期期間'].forEach((needle) => {
      ok(text.indexOf(needle) !== -1, needle);
    });
  });

  test('removeAllEvents は管理下の予定だけを消す', () => {
    const calendar = fakeCalendar();
    const api = loadGas({ Calendar: calendar, properties: { _calendarId: 'cal-123' } });
    offlineConfig(api);
    api.syncCalendar();
    const before = calendar.events.size;
    ok(before > 0);
    api.removeAllEvents();
    eq(calendar.events.size, 0, '同期期間内の管理イベントが消えること');
  });
});

process.exitCode = require('./assert').report();
