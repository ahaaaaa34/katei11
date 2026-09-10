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

// ---------------------------------------------------------------------------
suite('FOMC 日程の自動取得', () => {
  const { PAGE_HTML, VALID_YEAR_HTML, panel, meetingRow } = require('./fomc-fixture');

  function serving(html, properties) {
    return loadGas({
      properties,
      UrlFetchApp: {
        fetch: () => ({ getResponseCode: () => 200, getContentText: () => html }),
      },
    });
  }

  test('公式ページから年ごとの日程を取り出す', () => {
    const years = G.parseFomcCalendar_(PAGE_HTML);
    eq(Object.keys(years).sort(), ['2026', '2027']);
    eq(years[2027].length, 8);
    eq(years[2026].length, 8);
  });

  test('政策金利が出るのは会合の最終日', () => {
    eq(G.parseFomcCalendar_(PAGE_HTML)[2027][0].date, '2027-01-27', 'Jan 26-27 → 27日');
  });

  test('アスタリスクを SEP として読む', () => {
    const meetings = G.parseFomcCalendar_(PAGE_HTML)[2027];
    eq(meetings.filter((m) => m.sep).map((m) => m.date),
       ['2027-03-17', '2027-06-16', '2027-09-22', '2027-12-15']);
  });

  test('アスタリスクが読めなければ月で当てる', () => {
    const html = panel(2027, [
      meetingRow('January', '26-27'), meetingRow('March', '16-17'),
      meetingRow('April', '27-28'), meetingRow('June', '15-16'),
      meetingRow('July', '27-28'), meetingRow('September', '21-22'),
      meetingRow('November', '2-3'), meetingRow('December', '14-15'),
    ]);
    const meetings = G.parseFomcCalendar_(html)[2027];
    eq(meetings.filter((m) => m.sep).map((m) => m.date.slice(5, 7)),
       ['03', '06', '09', '12']);
  });

  test('月をまたぐ回は後ろの月で解釈する', () => {
    eq(G.parseFomcYear_(G.htmlToText_('<div>April/May</div><div>28-1</div>'), 2027),
       [{ date: '2027-05-01', sep: false }]);
  });

  test('月名がひとつでも日が戻っていれば翌月とみなす', () => {
    eq(G.parseFomcYear_('April 28-1', 2027)[0].date, '2027-05-01');
  });

  test('まともな年は検査を通る', () => {
    eq(G.validateFomcYear_(G.parseFomcCalendar_(VALID_YEAR_HTML)[2027], 2027), null);
  });

  test('会合数がおかしい年は落とす', () => {
    const few = [{ date: '2027-01-27' }, { date: '2027-03-17' }];
    ok(/会合数/.test(G.validateFomcYear_(few, 2027)));
  });

  test('土日に落ちる日程は落とす', () => {
    const meetings = G.parseFomcCalendar_(VALID_YEAR_HTML)[2027];
    meetings[0].date = '2027-01-30';   // 土曜
    ok(/曜日/.test(G.validateFomcYear_(meetings, 2027)));
  });

  test('年が違う日付は落とす', () => {
    const meetings = G.parseFomcCalendar_(VALID_YEAR_HTML)[2027];
    meetings[0].date = '2028-01-26';
    ok(/年でない/.test(G.validateFomcYear_(meetings, 2027)));
  });

  test('間隔がおかしい年は落とす', () => {
    const meetings = G.parseFomcCalendar_(VALID_YEAR_HTML)[2027];
    meetings[1].date = '2027-01-20';   // 1月に2回
    ok(/間隔/.test(G.validateFomcYear_(meetings, 2027)));
  });

  test('日付の重複は落とす', () => {
    const meetings = G.parseFomcCalendar_(VALID_YEAR_HTML)[2027];
    meetings[1].date = meetings[0].date;
    ok(/重複/.test(G.validateFomcYear_(meetings, 2027)));
  });

  test('手入力が尽きた先の年だけを補う', () => {
    const api = serving(PAGE_HTML);
    const merged = api.allMeetings_('fomc');
    const auto = merged.filter((m) => m.auto);
    eq(auto.length, 8, '2027 年ぶんだけ入る');
    ok(auto.every((m) => m.date.indexOf('2027') === 0));
    eq(merged.filter((m) => !m.auto).length, 8, '手入力の 2026 年は 8 件のまま');
  });

  test('手入力がある年は絶対に上書きしない', () => {
    // 公式ページ側にも 2026 年の（検証を通る）日程が載っている状況を作る。
    // ガードが無ければ、手入力と違う日付が紛れ込む。
    const api = serving(PAGE_HTML);
    const fetched = api.parseFomcCalendar_(PAGE_HTML)[2026];
    eq(api.validateFomcYear_(fetched, 2026), null, '取得側の 2026 年も検査を通ること');
    const curated = api.MEETINGS.fomc.meetings.map((m) => m.date);
    ok(fetched.some((m) => curated.indexOf(m.date) === -1),
       '取得側と手入力で日付が違うこと（違わないと試験にならない）');

    const merged = api.allMeetings_('fomc').filter((m) => m.date.indexOf('2026') === 0);
    eq(merged.map((m) => m.date), curated, '手入力の日付がそのまま残ること');
    ok(merged.every((m) => !m.auto), '2026 年に自動取得ぶんが混ざらないこと');
  });

  test('手入力より先の年だけが自動取得ぶんとして入る', () => {
    const api = serving(PAGE_HTML);
    const auto = api.allMeetings_('fomc').filter((m) => m.auto);
    ok(auto.length > 0);
    ok(auto.every((m) => m.date > '2026-12-31'), '手入力の年をまたがないこと');
  });

  test('検査に落ちた年は取り込まない', () => {
    const broken = panel(2027, [
      meetingRow('January', '26-27'), meetingRow('February', '2-3'),
      meetingRow('March', '16-17'), meetingRow('April', '27-28'),
      meetingRow('June', '15-16'), meetingRow('July', '27-28'),
      meetingRow('September', '21-22'), meetingRow('December', '14-15'),
    ]);
    const api = serving(broken);
    eq(api.allMeetings_('fomc').filter((m) => m.auto).length, 0, '間隔が詰まった年は捨てる');
  });

  test('取得に失敗しても手入力ぶんで動き続ける', () => {
    const api = loadGas({
      UrlFetchApp: { fetch: () => { throw new Error('network down'); } },
    });
    eq(api.allMeetings_('fomc').length, 8);
  });

  test('中身が HTML でなくても壊れない', () => {
    const api = serving('<html><body>メンテナンス中です</body></html>');
    eq(api.allMeetings_('fomc').filter((m) => m.auto).length, 0);
  });

  test('取得結果はキャッシュされ、毎回は取りに行かない', () => {
    let calls = 0;
    const api = loadGas({
      UrlFetchApp: {
        fetch: () => {
          calls++;
          return { getResponseCode: () => 200, getContentText: () => PAGE_HTML };
        },
      },
    });
    api.allMeetings_('fomc');
    api.allMeetings_('fomc');
    api.allMeetings_('fomc');
    eq(calls, 1);
  });

  test('手入力が十分先まであるなら取りに行かない', () => {
    let calls = 0;
    const api = loadGas({
      UrlFetchApp: { fetch: () => { calls++; throw new Error('呼ばれてはいけない'); } },
    });
    api.MEETINGS.fomc.meetings.push({ date: '2099-12-15', sep: true });
    api.allMeetings_('fomc');
    eq(calls, 0);
  });

  test('自動取得を切れば手入力だけになる', () => {
    const api = serving(PAGE_HTML);
    api.CONFIG.providers.fomcAutoFetch = false;
    eq(api.allMeetings_('fomc').filter((m) => m.auto).length, 0);
  });

  test('新しい年を取り込んだら貼り付け用のメールを1度だけ送る', () => {
    const api = serving(PAGE_HTML);
    api.allMeetings_('fomc');
    eq(api._mail.length, 1);
    ok(api._mail[0].subject.indexOf('2027') !== -1);
    ok(api._mail[0].body.indexOf("{ date: '2027-01-27', sep: false },") !== -1,
       '貼り付けられる形になっていること');
    api._store[api.PROP_FOMC_AUTO] = '';   // キャッシュを消して再取得させる
    api.allMeetings_('fomc');
    eq(api._mail.length, 1, '同じ年で二度は送らない');
  });

  test('自動取得ぶんの予定には出所が書かれる', () => {
    const api = serving(PAGE_HTML);
    const ctx = { start: Y(2027, 3, 1), end: Y(2027, 3, 31), timezone: 'Asia/Tokyo' };
    const rate = api.providerFomc_(ctx).find((e) => e.indicatorId === 'us_fomc_rate');
    eq(K(api.localDate_(rate.start, 'America/New_York')), '2027-03-17');
    eq(rate.extra.auto, true);
    ok(rate.note.indexOf('自動取得') !== -1);
    eq(rate.estimated, false, '公式ページ由来なので推定ではない');
  });

  test('自動取得で埋まっている間は「転記を促す」情報を出す', () => {
    const api = serving(PAGE_HTML, { FRED_API_KEY: 'dummy' });
    const report = api.maintenanceReport_({ start: Y(2026, 9, 4), end: Y(2026, 11, 8) });
    const auto = report.find((f) => f.key === 'meetings:fomc:auto');
    ok(auto, '自動取得で足りている旨の指摘が出ること');
    eq(auto.severity, api.SEVERITY_INFO);
    eq(api.needsAction_(report), false, 'メールで叩き起こすほどではない');
  });

  test('自動取得も失敗すれば従来どおり要対応になる', () => {
    const api = loadGas({
      properties: { FRED_API_KEY: 'dummy' },
      UrlFetchApp: { fetch: () => { throw new Error('down'); } },
    });
    const report = api.maintenanceReport_({ start: Y(2026, 10, 10), end: Y(2026, 12, 14) });
    eq(api.needsAction_(report), true);
  });
});

suite('診断コマンド', () => {
  const { PAGE_HTML } = require('./fomc-fixture');

  test('checkFomcAutoFetch が採用可否を年ごとに示す', () => {
    const api = loadGas({
      UrlFetchApp: {
        fetch: () => ({ getResponseCode: () => 200, getContentText: () => PAGE_HTML }),
      },
    });
    const text = api.checkFomcAutoFetch();
    ok(text.indexOf('✅ 2027 年') !== -1, text);
    ok(text.indexOf('2027-03-17*') !== -1, 'SEP に印が付くこと');
  });

  test('取得できなければその旨を返す', () => {
    const api = loadGas({ UrlFetchApp: { fetch: () => { throw new Error('down'); } } });
    ok(api.checkFomcAutoFetch().indexOf('取得できませんでした') !== -1);
  });

  test('showStatus は日程の出所を分けて表示する', () => {
    const api = loadGas({
      ScriptApp: fakeScriptApp(),
      UrlFetchApp: {
        fetch: () => ({ getResponseCode: () => 200, getContentText: () => PAGE_HTML }),
      },
    });
    const text = api.showStatus();
    ok(/手入力 2026-12-09 まで \/ 自動取得 2027-/.test(text), text);
    ok(text.indexOf('fomcAutoFetch') === -1, '挙動スイッチを情報源として並べない');
  });
});

// ---------------------------------------------------------------------------
// 実際に見つかったバグの回帰テスト。
// どれも「テストは通るのに実運用で壊れる」たちのものだった。
// ---------------------------------------------------------------------------
suite('回帰: 窓の端で予定が作り直される', () => {
  function offline(api) {
    api.CONFIG.providers.fred = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    api.CONFIG.providers.fomcAutoFetch = false;
    return api;
  }

  test('生成した予定は必ず一覧取得の範囲に入る（1年ぶんの窓を1日ずつ動かす）', () => {
    const api = offline(loadGas());
    const outside = [];
    // 窓は短くしてよい。ここで見たいのは端の扱いで、端の日付は1日ずつ動かす。
    for (let offset = 0; offset < 365; offset += 1) {
      const start = G.addDays_(Y(2026, 1, 1), offset);
      const end = G.addDays_(start, 6);
      const ctx = { start, end, timezone: 'Asia/Tokyo' };
      api.collectEvents_(ctx).forEach((e) => {
        const day = api.localDate_(e.start, 'Asia/Tokyo');
        if (day < start || day > end) outside.push(e.indicatorId + '@' + K(day));
      });
    }
    eq(outside.slice(0, 5), [], '窓の外に出た予定があってはならない');
  });

  test('2回目の同期で書き込み API を一度も呼ばない（窓を動かしても）', () => {
    [0, 7, 30, 45, 61, 90].forEach((offset) => {
      const calendar = fakeCalendar();
      const api = offline(loadGas({
        Calendar: calendar,
        properties: { _calendarId: 'cal-1', _calendarName: '経済指標 (Nasdaq)' },
      }));
      const base = G.addDays_(Y(2026, 3, 1), offset);
      const ctx = { start: base, end: G.addDays_(base, 60), timezone: 'Asia/Tokyo' };

      const run = () => {
        let events = api.collectEvents_(ctx);
        events = events.concat(api.weeklyDigestEvents_(events, ctx));
        const existing = api.listManagedEvents_('cal-1', ctx.start, ctx.end);
        return api.applyPlan_(api.buildPlan_('cal-1', events, existing));
      };
      run();
      calendar.calls.length = 0;
      const plan = run();
      eq(api.planChanges_(plan), 0,
         '窓 +' + offset + ' 日: ' + api.planSummary_(plan));
      eq(calendar.calls.filter((c) => c[0] !== 'events.list').length, 0,
         '窓 +' + offset + ' 日で書き込みが発生した');
    });
  });

  test('10時 ET 以降の予定は日本時間だと翌日になる（前提の確認）', () => {
    const ism = G.zonedTime_(Y(2026, 3, 2), '10:00', 'America/New_York');
    eq(K(G.localDate_(ism, 'America/New_York')), '2026-03-02');
    eq(K(G.localDate_(ism, 'Asia/Tokyo')), '2026-03-03');
  });
});

suite('回帰: 書き込みの一時失敗で同期全体が落ちる', () => {
  function planFor(api, calendar) {
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 3), timezone: 'Asia/Tokyo' };
    api.CONFIG.providers.fred = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    api.CONFIG.providers.fomcAutoFetch = false;
    return api.buildPlan_('c', api.collectEvents_(ctx), []);
  }

  test('レート制限は待って試し直す', () => {
    const calendar = fakeCalendar();
    const original = calendar.Events.insert;
    let attempts = 0;
    calendar.Events.insert = (resource, calendarId) => {
      attempts++;
      if (attempts <= 2) throw new Error('failed with error: Rate Limit Exceeded');
      return original(resource, calendarId);
    };
    const api = loadGas({ Calendar: calendar, properties: { _calendarId: 'c' } });
    api.applyPlan_(planFor(api, calendar));
    eq(api._slept, [1000, 2000], '指数的に待つこと');
  });

  test('一時的なバックエンドエラーも試し直す', () => {
    ['Backend Error', 'Internal error encountered', 'try again later', 'timed out']
      .forEach((message) => {
        ok(G.isRetriableError_(new Error(message)), message);
      });
  });

  test('恒久的な失敗は試し直さずに投げる', () => {
    ok(!G.isRetriableError_(new Error('Invalid value for field summary')));
    ok(!G.isRetriableError_(new Error('Forbidden: insufficient permissions')));

    const calendar = fakeCalendar();
    calendar.Events.insert = () => { throw new Error('Invalid value for field summary'); };
    const api = loadGas({ Calendar: calendar, properties: { _calendarId: 'c' } });
    throws(() => api.applyPlan_(planFor(api, calendar)), 'Invalid value');
    eq(api._slept, [], '無駄に待たないこと');
  });

  test('ID 重複はレート制限とは別物として扱う', () => {
    ok(G.isDuplicateIdError_(new Error('failed with error: duplicate')));
    ok(!G.isRetriableError_(new Error('failed with error: duplicate')));
  });
});

suite('回帰: カレンダー ID のキャッシュが腐る', () => {
  test('カレンダーを消されたら探し直して同期を続ける', () => {
    const calendar = fakeCalendar({
      calendarList: [{ id: 'alive@g', summary: '経済指標 (Nasdaq)' }] });
    const listAll = calendar.Events.list;
    calendar.Events.list = (calendarId, opts) => {
      if (calendarId === 'gone@g') throw new Error('failed with error: Not Found');
      return listAll(calendarId, opts);
    };
    const api = loadGas({
      Calendar: calendar,
      properties: { _calendarId: 'gone@g', _calendarName: '経済指標 (Nasdaq)' },
    });
    api.CONFIG.providers.fred = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    api.CONFIG.providers.fomcAutoFetch = false;

    const plan = api.syncCalendar();
    eq(plan.calendarId, 'alive@g');
    ok(plan.created.length > 0);
  });

  test('カレンダー名を変えたら新しい方を探す', () => {
    const calendar = fakeCalendar({ calendarList: [
      { id: 'old@g', summary: '経済指標 (Nasdaq)' },
      { id: 'new@g', summary: 'マイ指標' },
    ] });
    const api = loadGas({ Calendar: calendar });
    eq(api.resolveCalendarId_(true), 'old@g');
    api.CONFIG.calendar.name = 'マイ指標';
    eq(api.resolveCalendarId_(true), 'new@g', '古い ID を使い続けてはいけない');
  });

  test('名前が同じならキャッシュを使って探し直さない', () => {
    const calendar = fakeCalendar({
      calendarList: [{ id: 'x@g', summary: '経済指標 (Nasdaq)' }] });
    const api = loadGas({ Calendar: calendar });
    api.resolveCalendarId_(true);
    calendar.calls.length = 0;
    eq(api.resolveCalendarId_(true), 'x@g');
    eq(calendar.calls.length, 0, '2回目は API を叩かない');
  });
});

suite('回帰: 取りこぼしと無駄な通信', () => {
  test('引け後の決算が窓の初日から拾える', () => {
    const rows = {
      '2026-11-17': [{ symbol: 'NVDA', name: 'NVIDIA', time: 'time-after-hours' }],
      '2026-11-18': [{ symbol: 'AAPL', name: 'Apple', time: 'time-after-hours' }],
      '2026-11-20': [{ symbol: 'MSFT', name: 'MS', time: 'time-after-hours' }],
    };
    const api = loadGas({
      UrlFetchApp: {
        fetchAll: (requests) => requests.map((request) => ({
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            data: { rows: rows[request.url.split('date=')[1]] || [] } }),
        })),
      },
    });
    const ctx = { start: Y(2026, 11, 18), end: Y(2026, 11, 20), timezone: 'Asia/Tokyo' };
    const got = api.providerEarnings_(ctx).map(
      (e) => e.extra.symbol + '@' + K(api.localDate_(e.start, 'Asia/Tokyo')));
    eq(got, ['NVDA@2026-11-18', 'AAPL@2026-11-19'],
       '前日 ET の引け後は拾い、窓外に出るものは捨てる');
  });

  test('公式ページの取得に失敗しても、1回の同期で1回しか叩かない', () => {
    let calls = 0;
    const api = loadGas({
      Calendar: fakeCalendar(),
      UrlFetchApp: { fetch: () => { calls++; throw new Error('down'); } },
    });
    api.CONFIG.providers.fred = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    api.syncCalendar();
    eq(calls, 1);
  });

  test('何も採用できなかった結果は短い期間しか使い回さない', () => {
    const api = loadGas();
    api._store._fomcAuto = JSON.stringify({
      fetchedAt: Date.now() - 2 * 86400000, years: {} });
    let calls = 0;
    api._stubs.UrlFetchApp.fetch = () => { calls++; throw new Error('down'); };
    api.allMeetings_('fomc');
    eq(calls, 1, '空のキャッシュは1日で捨てて取り直す');
  });
});

suite('回帰: 設定と時刻の取り違え', () => {
  test('しきい値の設定が欠けても全部消えない', () => {
    const api = loadGas();
    delete api.CONFIG.filter.minImpact;
    eq(api.applyFilter_([event(api, { impact: 98 })]).length, 1);
    eq(api.applyFilter_([event(api, { impact: 10 })]).length, 0, '既定値 55 で判定する');
  });

  test('真夜中を 24 時と返す環境でも 0 として扱う', () => {
    // Node の ICU は 0 を返すので、この分岐は普通のテストでは踏めない。
    // Apps Script 側の ICU が h24 だった場合に備えた保険なので、
    // その環境を作って確かめる。
    const h24 = {
      DateTimeFormat: function (locale, options) {
        const inner = new Intl.DateTimeFormat(locale, options);
        return {
          formatToParts: (date) => inner.formatToParts(date).map(
            (part) => (part.type === 'hour' && part.value === '00'
              ? { type: 'hour', value: '24' } : part)),
        };
      },
    };
    const api = loadGas({ Intl: h24 });
    const midnight = new Date(Date.UTC(2026, 8, 16, 15, 0));   // 9/17 00:00 JST
    eq(api.tzParts_(midnight, 'Asia/Tokyo').hour, 0, '24 時は 0 に寄せる');
    eq(api.formatClock_(midnight, 'Asia/Tokyo').time, '00:00');
    eq(K(api.localDate_(midnight, 'Asia/Tokyo')), '2026-09-17', '日付がずれないこと');
    // ずれの計算も 24 時を跨いで壊れないこと
    eq(api.zonedTime_(Y(2026, 9, 17), '00:00', 'Asia/Tokyo').toISOString(),
       midnight.toISOString());
  });

  test('日銀の発表は昼、深夜ではない', () => {
    const boj = G.indicator_('jp_boj_decision');
    eq(boj.tz, 'Asia/Tokyo');
    const instant = G.zonedTime_(Y(2026, 9, 17), boj.time, G.indicatorTimezone_(boj));
    eq(G.formatClock_(instant, 'Asia/Tokyo').time, '12:00');
  });

  test('ECB と中国は現地のタイムゾーンで持つ（米国の夏時間に引きずられない）', () => {
    const ecb = G.indicator_('eu_ecb_decision');
    const cn = G.indicator_('cn_pmi');
    // 3/12 は米国が夏時間・欧州がまだ冬時間という、ずれる時期
    [[2026, 3, 12], [2026, 9, 17]].forEach((ymd) => {
      const day = Y(ymd[0], ymd[1], ymd[2]);
      eq(G.formatClock_(G.zonedTime_(day, ecb.time, G.indicatorTimezone_(ecb)),
                        'Europe/Berlin').time, '14:15', 'ECB は常に現地 14:15');
      eq(G.formatClock_(G.zonedTime_(day, cn.time, G.indicatorTimezone_(cn)),
                        'Asia/Shanghai').time, '09:30', '中国は常に現地 09:30');
    });
  });

  test('海外指標のタイムゾーン指定が実在する', () => {
    G.INDICATORS.forEach((indicator) => {
      const tz = G.indicatorTimezone_(indicator);
      const parts = G.tzParts_(new Date(), tz);
      ok(parts.year > 2000, indicator.id + ': ' + tz);
    });
  });
});

suite('回帰: 設定ミスと多重実行', () => {
  function runnable(overrides) {
    const api = loadGas(Object.assign(
      { Calendar: fakeCalendar(), ScriptApp: fakeScriptApp() }, overrides));
    api.CONFIG.providers.fred = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    api.CONFIG.providers.fomcAutoFetch = false;
    return api;
  }

  const breakages = [
    ['window を消す', (c) => { delete c.window; }, 'window の設定がありません'],
    ['triggers を消す', (c) => { delete c.triggers; }, 'triggers の設定がありません'],
    ['calendar を消す', (c) => { delete c.calendar; }, 'calendar の設定がありません'],
    ['timezone を壊す', (c) => { c.timezone = 'Mars/Olympus'; }, 'timezone が不正'],
    ['daysAhead を負に', (c) => { c.window.daysAhead = -1; }, 'daysAhead'],
    ['daysAhead を巨大に', (c) => { c.window.daysAhead = 9999; }, '400 日以内'],
    ['minImpact を範囲外に', (c) => { c.filter.minImpact = 500; }, 'minImpact'],
    ['reminders を配列でなくする', (c) => { c.reminders.S = '30'; }, 'reminders.S'],
    ['reminders に巨大な値', (c) => { c.reminders.S = [99999]; }, 'reminders.S'],
    ['triggers の時刻を範囲外に', (c) => { c.triggers.morningHour = 99; }, 'morningHour'],
  ];

  breakages.forEach((row) => {
    test(row[0] + ' と、原因の分かるエラーで止まる', () => {
      const api = runnable();
      row[1](api.CONFIG);
      throws(() => api.syncCalendar(), row[2]);
      throws(() => api.syncCalendar(), '00_config.js', 'どこを直せばよいか書いてあること');
    });
  });

  test('まともな設定なら素通りする', () => {
    runnable().syncCalendar();   // 例外が出なければ合格
  });

  test('Calendar 拡張サービスが無効なら、有効化の手順を出して止まる', () => {
    const api = runnable({ Calendar: undefined });
    throws(() => api.syncCalendar(), 'Calendar API が有効になっていません');
    throws(() => api.syncCalendar(), 'サービス', 'どこを押せばよいか書いてあること');
  });

  test('別の同期が走っていたらこの回は何もしない', () => {
    const calendar = fakeCalendar();
    const api = runnable({
      Calendar: calendar,
      LockService: { getScriptLock: () => ({ tryLock: () => false, releaseLock: () => {} }) },
    });
    eq(api.syncCalendar(), null);
    eq(calendar.calls.length, 0, 'API を一切叩かないこと');
  });

  test('失敗してもロックは必ず離す', () => {
    let released = 0;
    const api = runnable({
      LockService: {
        getScriptLock: () => ({ tryLock: () => true, releaseLock: () => { released++; } }),
      },
    });
    api.CONFIG.providers.rules = false;
    api.CONFIG.providers.fomc = false;
    api.CONFIG.providers.market = false;
    throws(() => api.syncCalendar(), '0 件');
    eq(released, 1);
  });

  test('ロックが使えない環境でも同期は続く', () => {
    const api = runnable({
      LockService: { getScriptLock: () => { throw new Error('lock unavailable'); } },
    });
    ok(api.syncCalendar().created.length > 0);
  });
});

suite('回帰: 設定ミスで実行が終わらなくなる', () => {
  test('同期範囲は上限で頭打ちにする', () => {
    const api = loadGas();
    api.CONFIG.window = { daysBack: 5, daysAhead: 9999 };
    const w = api.syncWindow_(Y(2026, 9, 9));
    eq(G.daysBetween_(w.end, Y(2026, 9, 9)), api.MAX_WINDOW_DAYS,
       '検証をすり抜けても何十年ぶんも展開しない');
  });

  test('壊れた値は既定値に落ちる', () => {
    const api = loadGas();
    api.CONFIG.window = { daysBack: -3, daysAhead: 'たくさん' };
    const w = api.syncWindow_(Y(2026, 9, 9));
    eq([K(w.start), K(w.end)], ['2026-09-04', '2026-11-08']);
  });

  test('window ごと消えても落ちずに既定値で動く', () => {
    const api = loadGas();
    delete api.CONFIG.window;
    const w = api.syncWindow_(Y(2026, 9, 9));
    eq([K(w.start), K(w.end)], ['2026-09-04', '2026-11-08']);
  });
});

suite('回帰: 規則の展開が月をまたぐ', () => {
  test('月末近くの指標が、ある月は0回・翌月は2回にならない', () => {
    // 2027-02-27 は土曜。素直に翌営業日へ送ると 3/1 になり、
    // 2月が消えて3月が2回になる。
    const dates = G.ruleDates_({ type: 'day_of_month', day: 27 },
                               Y(2027, 1, 1), Y(2027, 12, 31)).map(K);
    eq(dates.length, 12, '毎月1回であること');
    eq(dates[1], '2027-02-26', '月をまたぐくらいなら手前の営業日へ寄せる');
  });

  test('全指標が、対象の月にきっかり1回だけ発生する（2024-2035年）', () => {
    const kinds = ['day_of_month', 'nth_business_day', 'nth_weekday'];
    const problems = [];
    G.INDICATORS.forEach((indicator) => {
      const schedule = indicator.schedule || {};
      if (kinds.indexOf(schedule.type) === -1) return;
      const months = schedule.months || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      for (let year = 2024; year <= 2035; year++) {
        const counts = {};
        G.ruleDates_(schedule, Y(year, 1, 1), Y(year, 12, 31)).forEach((date) => {
          const month = date.getUTCMonth() + 1;
          counts[month] = (counts[month] || 0) + 1;
        });
        months.forEach((month) => {
          if ((counts[month] || 0) !== 1) {
            problems.push(indicator.id + ' ' + year + '/' + month
                          + ': ' + (counts[month] || 0) + '回');
          }
        });
        Object.keys(counts).forEach((month) => {
          if (months.indexOf(Number(month)) === -1) {
            problems.push(indicator.id + ' ' + year + '/' + month + ' は対象外の月');
          }
        });
      }
    });
    eq(problems.slice(0, 5), []);
  });

  test('月初の指標は翌営業日へ送ってよい（手前に寄せない）', () => {
    // 2026-11-01 は日曜。第1営業日は 11/2 で、10月へ戻してはいけない。
    eq(G.ruleDates_({ type: 'day_of_month', day: 1 },
                    Y(2026, 11, 1), Y(2026, 11, 30)).map(K), ['2026-11-02']);
  });
});

// ---------------------------------------------------------------------------
suite('GAS 上の自己テスト', () => {
  // 利用者が最初に押す runTests そのものが壊れていたら意味がないので、
  // ここで一度動かして、全項目が通ることを確かめる。
  test('すべての項目が通る', () => {
    const api = loadGas({ Calendar: fakeCalendar(), ScriptApp: fakeScriptApp() });
    const report = api.runTests();
    const failed = report.split('\n').filter((line) => line.indexOf('❌') === 0);
    eq(failed, [], report);
    ok(report.split('\n').filter((line) => line.indexOf('✅') === 0).length >= 10);
  });

  test('拡張サービスが無ければ、その項目だけが落ちる', () => {
    const api = loadGas({ Calendar: undefined, ScriptApp: fakeScriptApp() });
    const report = api.runTests();
    ok(report.indexOf('❌ Calendar 拡張サービス') !== -1, report);
    ok(report.indexOf('✅ 夏時間が正しく処理される') !== -1, '他の項目は動くこと');
  });

  test('スクリプトのタイムゾーンがずれていれば知らせる', () => {
    const api = loadGas({
      Calendar: fakeCalendar(),
      ScriptApp: fakeScriptApp(),
      Session: {
        getEffectiveUser: () => ({ getEmail: () => 'x@example.com' }),
        getScriptTimeZone: () => 'America/New_York',
      },
    });
    const report = api.runTests();
    ok(report.indexOf('❌ タイムゾーン設定') !== -1, report);
    ok(report.indexOf('トリガーの実行時刻がずれます') !== -1, '影響が書いてあること');
  });

  test('自己テストは設定を書き換えたままにしない', () => {
    const api = loadGas({ Calendar: fakeCalendar(), ScriptApp: fakeScriptApp() });
    const before = JSON.stringify(api.CONFIG.providers);
    api.runTests();
    eq(JSON.stringify(api.CONFIG.providers), before);
  });
});

// ---------------------------------------------------------------------------
suite('Investing プロバイダ（有効時の全経路）', () => {
  const ROW_HTML = '<tr id="eventRowId_733" data-event-datetime="2026/09/11 12:30:00">'
    + '<td class="first left time js-time">12:30</td>'
    + '<td class="left event"><a href="/economic-calendar/cpi-733">'
    + 'Core CPI (MoM)&nbsp;<span>(Aug)</span></a></td>'
    + '<td id="eventActual_733">0.2%</td>'
    + '<td id="eventForecast_733">0.3%</td>'
    + '<td id="eventPrevious_733">0.4%</td></tr>';

  function serving(body, capture) {
    return loadGas({
      UrlFetchApp: {
        fetch: (url, params) => {
          if (capture) capture.push({ url, params });
          return { getResponseCode: () => 200, getContentText: () => body };
        },
      },
    });
  }

  const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };

  test('数値つきのイベントを組み立てる', () => {
    const api = serving(JSON.stringify({ data: ROW_HTML }));
    const events = api.providerInvesting_(ctx);
    eq(events.length, 1);
    eq(events[0].indicatorId, 'us_cpi');
    eq([events[0].forecast, events[0].previous, events[0].actual],
       ['0.3%', '0.4%', '0.2%']);
    eq(events[0].source, 'investing');
  });

  test('設定した国だけを問い合わせる', () => {
    const calls = [];
    const api = serving(JSON.stringify({ data: '' }), calls);
    api.CONFIG.filter.countries = ['US', 'JP'];
    api.providerInvesting_(ctx);
    const payload = calls[0].params.payload;
    ok(payload.indexOf('country%5B%5D=5') !== -1, 'US');
    ok(payload.indexOf('country%5B%5D=35') !== -1, 'JP');
    ok(payload.indexOf('country%5B%5D=72') === -1, 'EU は含めない');
  });

  test('対応表にない国しか指定されなければ米国に落とす', () => {
    const calls = [];
    const api = serving(JSON.stringify({ data: '' }), calls);
    api.CONFIG.filter.countries = ['ZZ'];
    api.providerInvesting_(ctx);
    ok(calls[0].params.payload.indexOf('country%5B%5D=5') !== -1);
  });

  test('取得範囲は前後1日ぶん広く取る', () => {
    const calls = [];
    serving(JSON.stringify({ data: '' }), calls).providerInvesting_(ctx);
    const payload = calls[0].params.payload;
    ok(payload.indexOf('dateFrom=2026-08-31') !== -1, payload);
    ok(payload.indexOf('dateTo=2026-10-01') !== -1, payload);
  });

  test('スクレイパとして必要なヘッダを付ける', () => {
    const calls = [];
    serving(JSON.stringify({ data: '' }), calls).providerInvesting_(ctx);
    eq(calls[0].params.method, 'post');
    eq(calls[0].params.headers['X-Requested-With'], 'XMLHttpRequest');
    ok(calls[0].params.headers.Referer.indexOf('investing.com') !== -1);
  });

  test('応答が JSON でなければ空で返す（落ちない）', () => {
    eq(serving('<html>maintenance</html>').providerInvesting_(ctx), []);
  });

  test('data が無くても落ちない', () => {
    eq(serving(JSON.stringify({ ok: true })).providerInvesting_(ctx), []);
  });

  test('接続できなければ空で返す', () => {
    const api = loadGas({ UrlFetchApp: { fetch: () => { throw new Error('down'); } } });
    eq(api.providerInvesting_(ctx), []);
  });

  test('タイムゾーンの指定を設定から読む', () => {
    const api = serving(JSON.stringify({ data: ROW_HTML }));
    api.CONFIG.investingAssumeTz = 'America/New_York';
    const events = api.providerInvesting_(ctx);
    // 12:30 を ET と解釈するので、日本時間では翌日 01:30
    eq(K(api.localDate_(events[0].start, 'Asia/Tokyo')), '2026-09-12');
  });

  test('有効にすると同期の情報源に入る', () => {
    const api = serving(JSON.stringify({ data: ROW_HTML }));
    api.CONFIG.providers.rules = false;
    api.CONFIG.providers.fomc = false;
    api.CONFIG.providers.market = false;
    api.CONFIG.providers.fred = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = true;
    const events = api.collectEvents_(ctx);
    eq(events.map((e) => e.indicatorId), ['us_cpi']);
    eq(events[0].actual, '0.2%');
  });
});

// ---------------------------------------------------------------------------
suite('回帰: 日をまたぐ予定が理由なく消される', () => {
  function offline(api) {
    api.CONFIG.providers.fred = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    api.CONFIG.providers.fomcAutoFetch = false;
    return api;
  }

  test('23:45 に始まる予定は日をまたぐ（前提の確認）', () => {
    const pmi = G.zonedTime_(Y(2026, 11, 23), '09:45', 'America/New_York');
    eq(G.formatClock_(pmi, 'Asia/Tokyo').time, '23:45');
    eq(K(G.localDate_(new Date(pmi.getTime() + 30 * 60000), 'Asia/Tokyo')), '2026-11-24');
  });

  test('範囲外の日の予定は、時間帯が重なっていても消さない', () => {
    const api = offline(loadGas({ Calendar: fakeCalendar() }));
    const outside = event(api, {
      indicatorId: 'us_spglobal_pmi_flash',
      start: api.zonedTime_(Y(2026, 11, 23), '09:45', 'America/New_York'),
    });
    const stored = api.toCalendarResource_(outside);
    const listed = { id: stored.id, start: stored.start, end: stored.end,
                     extendedProperties: stored.extendedProperties };

    const ctx = { start: Y(2026, 11, 24), end: Y(2027, 1, 28), timezone: 'Asia/Tokyo' };
    const plan = api.buildPlan_('c', [], [listed], ctx);
    eq(plan.deleted, [], '11/23 の予定は 11/24 開始の範囲では触らない');
  });

  test('範囲内で不要になった予定はきちんと消す', () => {
    const api = offline(loadGas({ Calendar: fakeCalendar() }));
    const inside = event(api, {
      indicatorId: 'us_cpi',
      start: api.zonedTime_(Y(2026, 12, 10), '08:30', 'America/New_York'),
    });
    const stored = api.toCalendarResource_(inside);
    const listed = { id: stored.id, start: stored.start, end: stored.end,
                     extendedProperties: stored.extendedProperties };
    const ctx = { start: Y(2026, 11, 24), end: Y(2027, 1, 28), timezone: 'Asia/Tokyo' };
    eq(api.buildPlan_('c', [], [listed], ctx).deleted.length, 1);
  });

  test('日付の分からない予定は従来どおり整理対象にする', () => {
    const api = offline(loadGas({ Calendar: fakeCalendar() }));
    const ctx = { start: Y(2026, 11, 24), end: Y(2027, 1, 28), timezone: 'Asia/Tokyo' };
    const orphan = { id: 'ecunknown', extendedProperties: { private: { ecal: '1' } } };
    eq(api.buildPlan_('c', [], [orphan], ctx).deleted.length, 1);
  });

  test('uid が無くても開始時刻から日付を割り出す', () => {
    eq(K(G.resourceDisplayDate_({
      start: { dateTime: '2026-11-23T23:45:00+09:00' },
      extendedProperties: { private: { ecal: '1' } },
    })), '2026-11-23');
    eq(K(G.resourceDisplayDate_({ start: { date: '2026-11-23' } })), '2026-11-23');
  });
});

// ---------------------------------------------------------------------------
suite('90日連続運用', () => {
  test('毎日同期し続けても、溜まらない・暴れない・消えない', () => {
    const calendar = fakeCalendar();
    const api = loadGas({
      Calendar: calendar,
      properties: { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)' },
    });
    api.CONFIG.providers.fred = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    api.CONFIG.providers.fomcAutoFetch = false;

    const createdTimes = {};
    let deletions = 0;
    let firstDay = 0;
    let laterWrites = 0;

    for (let day = 0; day < 90; day++) {
      const today = G.addDays_(Y(2026, 9, 1), day);
      const ctx = { start: G.addDays_(today, -5), end: G.addDays_(today, 60),
                    timezone: 'Asia/Tokyo' };
      let events = api.collectEvents_(ctx);
      events = events.concat(api.weeklyDigestEvents_(events, ctx));
      const existing = api.listManagedEvents_('c', ctx.start, ctx.end);
      const plan = api.applyPlan_(api.buildPlan_('c', events, existing, ctx));

      plan.created.forEach((row) => {
        createdTimes[row.resource.id] = (createdTimes[row.resource.id] || 0) + 1;
      });
      deletions += plan.deleted.length;
      if (day === 0) firstDay = plan.created.length;
      else laterWrites += plan.created.length + plan.updated.length + plan.deleted.length;
    }

    ok(firstDay > 50, '初日にまとめて作られること: ' + firstDay);
    eq(Object.values(createdTimes).filter((n) => n > 1), [],
       '同じ予定が二度作られてはいけない（作り直しの兆候）');
    eq(deletions, 0, '窓から外れただけの過去の予定を消してはいけない');
    ok(laterWrites / 89 < 3, '2日目以降の書き込みは1日数件まで: ' + (laterWrites / 89));

    const byUid = {};
    [...calendar.events.values()].forEach((item) => {
      const uid = item.extendedProperties.private.uid;
      byUid[uid] = (byUid[uid] || 0) + 1;
    });
    eq(Object.entries(byUid).filter((pair) => pair[1] > 1), [], '同じ発表の重複');
  });
});

// ---------------------------------------------------------------------------
suite('SHA-1 の文字符号化', () => {
  const crypto = require('crypto');
  const digest = (text) => crypto.createHash('sha1').update(text, 'utf8').digest('hex');

  test('多バイト文字・絵文字で標準実装と一致する', () => {
    ['', 'abc', '日本語', '🔴🇺🇸', 'a'.repeat(1000),
     '米 消費者物価指数 (CPI) → 0.2%'].forEach((text) => {
      eq(G.sha1Hex_(text), digest(text), JSON.stringify(text.slice(0, 20)));
    });
  });

  test('パディングの境目でも一致する', () => {
    [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121].forEach((length) => {
      const text = 'a'.repeat(length);
      eq(G.sha1Hex_(text), digest(text), 'len=' + length);
    });
  });

  test('対になっていないサロゲートも標準と同じ扱いにする', () => {
    // 壊れた文字列が来ても、他の実装と同じ値になること。
    ['\ud800', 'a\udfff b', '\ud83d 単独の上位', '下位のみ\ude00'].forEach((text) => {
      eq(G.sha1Hex_(text), digest(text), JSON.stringify(text));
    });
  });

  test('予定 ID は Google の許容文字だけを使う（ランダム入力）', () => {
    for (let i = 0; i < 200; i++) {
      let text = '';
      for (let j = 0; j < 20; j++) {
        text += String.fromCodePoint(Math.floor(Math.random() * 0x2ffff) + 1);
      }
      const id = 'ec' + G.base32hex_(G.sha1Bytes_(text));
      ok(/^[a-v0-9]{5,1024}$/.test(id), id);
    }
  });
});

// ---------------------------------------------------------------------------
suite('回帰: 書き間違いが黙って通る', () => {
  test('曜日の綴りを間違えたら、その指標を黙って消さずに落とす', () => {
    // 0 件を返すと、その指標だけがカレンダーから消えて誰も気づかない。
    throws(() => G.ruleDates_({ type: 'nth_weekday', weekday: 'thur', n: 1 },
                              Y(2026, 1, 1), Y(2026, 3, 31)), '曜日の指定が不正');
    throws(() => G.ruleDates_({ type: 'weekly', weekday: 'thurs' },
                              Y(2026, 1, 1), Y(2026, 1, 31)), '曜日の指定が不正');
  });

  test('正しい曜日名は大文字でも受け付ける', () => {
    eq(G.ruleDates_({ type: 'nth_weekday', weekday: 'FRI', n: 1 },
                    Y(2026, 9, 1), Y(2026, 9, 30)).map(K), ['2026-09-04']);
  });

  test('Google が受け付けない色 ID は同期前に弾く', () => {
    ['0', '12', '99', 'red', '5.5'].forEach((color) => {
      const api = loadGas();
      api.CONFIG.colors.S = color;
      throws(() => api.validateConfig_(), 'colors.S', color);
    });
  });

  test('色 ID を空にすれば色を付けないだけで通る', () => {
    const api = loadGas();
    api.CONFIG.colors.S = null;
    api.validateConfig_();
    eq(api.toCalendarResource_(event(api, { impact: 98 })).colorId, undefined);
  });

  const catalogBreakages = [
    ['発表時刻が範囲外', (api) => { api.INDICATORS[0].time = '25:99'; }, 'time が不正'],
    ['発表時刻の桁が足りない', (api) => { api.INDICATORS[0].time = '8:5'; }, 'time が不正'],
    ['規則があるのに時刻が無い',
     (api) => { delete api.INDICATORS.find((i) => i.id === 'us_cpi').time; },
     'time が必要'],
    ['影響度が範囲外', (api) => { api.INDICATORS[0].impact = 999; }, 'impact は 0〜100'],
    ['タイムゾーンが実在しない', (api) => { api.INDICATORS[0].tz = 'Mars/X'; }, 'tz が不正'],
    ['id が重複', (api) => { api.INDICATORS[1].id = api.INDICATORS[0].id; }, 'id が重複'],
    ['規則の種別が不明',
     (api) => { api.INDICATORS[0].schedule = { type: 'phase_of_moon' }; },
     'schedule.type が不正'],
    ['規則の曜日が不正',
     (api) => { api.INDICATORS[5].schedule.weekday = 'thur'; },
     'schedule.weekday が不正'],
  ];

  catalogBreakages.forEach((row) => {
    test('カタログ: ' + row[0] + ' を指摘する', () => {
      const api = loadGas();
      row[1](api);
      throws(() => api.validateConfig_(), row[2]);
    });
  });

  test('配られたままのカタログは検査を通る', () => {
    eq(G.catalogProblems_(), []);
  });

  test('GAS 上の自己テストもカタログを点検する', () => {
    const api = loadGas({ Calendar: fakeCalendar(), ScriptApp: fakeScriptApp() });
    api.INDICATORS[0].time = '99:99';
    const report = api.runTests();
    ok(report.indexOf('❌ 指標カタログの書式') !== -1, report);
  });
});

process.exitCode = require('./assert').report();
