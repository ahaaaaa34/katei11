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
    // 既定は「根拠あり」。未確定の振る舞いを見たいテストは明示して上書きする。
    confidence: 'official',
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
    const guess = event(G, { source: 'rules', confidence: 'estimated',
                             start: new Date(Date.UTC(2026, 8, 10, 13, 0)) });
    const official = event(G, { source: 'fred', confidence: 'official' });
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
    const a = event(G, { source: 'rules', confidence: 'estimated', note: 'なぜ効くか' });
    const b = event(G, { source: 'investing', forecast: '1.0%' });
    eq(G.eventContentHash_(G.mergeEvent_(a, b)), G.eventContentHash_(G.mergeEvent_(b, a)));
  });

  test('根拠の確かな日付が、情報源の優先順位より強い', () => {
    // 優先順位は investing > rules だが、日付の根拠は rule > estimated。
    const weakHigh = event(G, { source: 'investing', confidence: 'estimated',
                                start: new Date(Date.UTC(2026, 8, 10, 16, 0)) });
    const strongLow = event(G, { source: 'rules', confidence: 'rule' });
    const merged = G.mergeEvent_(weakHigh, strongLow);
    eq(merged.confidence, 'rule');
    eq(merged.start.toISOString(), '2026-09-10T12:30:00.000Z');
  });

  test('根拠は official > reported > rule > estimated の順で強い', () => {
    eq(['official', 'reported', 'rule', 'estimated'].map(G.confidenceRank_),
       [4, 3, 2, 1]);
    const rule = event(G, { source: 'rules', confidence: 'rule' });
    const official = event(G, { source: 'fred', confidence: 'official',
                                start: new Date(Date.UTC(2026, 8, 10, 11, 0)) });
    eq(G.mergeEvent_(rule, official).confidence, 'official');
    eq(G.mergeEvent_(official, rule).confidence, 'official');
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
    eq(byId.us_ism_mfg.confidence, 'rule', '第1営業日は確定');
    eq(byId.us_cpi.confidence, 'estimated', '日付は概算');
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

  test('手入力の FOMC 日程は、照合するまで「未確定」として扱う', () => {
    // 人が書いた日程を「確定」と言い張らない。公式ページと照合して初めて
    // official に上がる（この ctx では取得していないので estimated のまま）。
    G.providerFomc_(ctx).forEach((e) => eq(e.confidence, 'estimated', e.indicatorId));
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
    eq(events[0].confidence, 'official', '統計局の公表日程そのもの');
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
      event(G, { source: 'rules', confidence: 'estimated' }),
      event(G, { source: 'fred' }),
      event(G, { source: 'investing', forecast: '0.3%' }),
    ], 'Asia/Tokyo');
    eq(merged.length, 1);
    eq(merged[0].source, 'fred');
    eq(merged[0].forecast, '0.3%');
  });

  test('近くに確定日が出たら推定日を捨てる', () => {
    const guess = event(G, { source: 'rules', confidence: 'estimated',
                             start: G.zonedTime_(Y(2026, 9, 14), '08:30', 'America/New_York') });
    const confirmed = event(G, { source: 'fred', confidence: 'official',
                                 start: G.zonedTime_(Y(2026, 9, 11), '08:30', 'America/New_York') });
    const kept = G.dropSupersededEstimates_([guess, confirmed], 'Asia/Tokyo');
    eq(kept.length, 1);
    eq(kept[0].source, 'fred');
  });

  test('月をまたぐ同一指標は別の発表として両方残す', () => {
    const guess = event(G, { source: 'rules', confidence: 'estimated',
                             start: G.zonedTime_(Y(2026, 10, 14), '08:30', 'America/New_York') });
    const confirmed = event(G, { source: 'fred', confidence: 'official',
                                 start: G.zonedTime_(Y(2026, 9, 11), '08:30', 'America/New_York') });
    eq(G.dropSupersededEstimates_([guess, confirmed], 'Asia/Tokyo').length, 2);
  });

  test('週次の指標は間引かれない', () => {
    const weekly = [3, 10, 17].map((day) => event(G, {
      indicatorId: 'us_jobless_claims', confidence: 'rule',
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
  // カレンダー側に既にある状態を、実際に書き込まれる姿から作る。
  function stored(api, ev, over) {
    const resource = api.toCalendarResource_(ev);
    return {
      id: resource.id,
      summary: resource.summary,
      start: resource.start,
      end: resource.end,
      extendedProperties: {
        private: Object.assign({}, resource.extendedProperties.private, over),
      },
    };
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
        .map((r) => r.minutes), [1440, 30], '最重要は前日と30分前');
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
    const plan = api.buildPlan_('cal-123', [after], [stored(api, before)]);
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
      start: api.zonedTime_(Y(2026, 9, 14), '08:30', 'America/New_York'), confidence: 'estimated' });
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
    ok(G.renderTitle_(event(G, { confidence: 'estimated' })).indexOf('予定日未確定') !== -1);
  });

  test('結果が出れば「予定日未確定」は消える', () => {
    const title = G.renderTitle_(event(G, { confidence: 'estimated', actual: '0.2%' }));
    ok(title.indexOf('予定日未確定') === -1 && title.indexOf('0.2%') !== -1);
  });

  test('説明文に数値と解説が入る', () => {
    const text = G.renderDescription_(event(G, {
      forecast: '0.3%', previous: '0.2%', actual: '0.4%', note: '効き方の説明' }));
    ['予想  0.3%', '前回  0.2%', '結果  0.4%', '効き方の説明', G.MARKER]
      .forEach((needle) => ok(text.indexOf(needle) !== -1, needle));
  });

  test('現地時刻も併記する', () => {
    ok(G.renderDescription_(event(G)).indexOf('ET)') !== -1);
  });

  test('数値が無ければその欄を出さない', () => {
    ok(G.renderDescription_(event(G)).indexOf('予想') === -1);
  });

  test('推定日は説明文でも警告する', () => {
    ok(G.renderDescription_(event(G, { confidence: 'estimated' })).indexOf('推定') !== -1);
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

  test('手入力の無い年は公式ページから補う', () => {
    const api = serving(PAGE_HTML);
    const merged = api.allMeetings_('fomc');
    const added = merged.filter((m) => m.date.indexOf('2027') === 0);
    eq(added.length, 8, '2027 年ぶんが入る');
    ok(added.every((m) => m.confidence === 'official'));
  });

  test('手入力と公式が食い違ったら、公式を採って知らせる', () => {
    // カレンダーに載せるべきは公式の日程。人が書いた方は記憶違いや写し間違いが
    // 入りうるので、検査を通った公式ページの記載を優先する。
    const api = serving(PAGE_HTML);
    const fetched = api.parseFomcCalendar_(PAGE_HTML)[2026];
    eq(api.validateFomcYear_(fetched, 2026), null, '取得側の 2026 年も検査を通ること');
    const curated = api.MEETINGS.fomc.meetings.map((m) => m.date);
    ok(fetched.some((m) => curated.indexOf(m.date) === -1),
       '取得側と手入力で日付が違うこと（違わないと試験にならない）');

    const merged = api.allMeetings_('fomc').filter((m) => m.date.indexOf('2026') === 0);
    eq(merged.map((m) => m.date), fetched.map((m) => m.date), '公式の日程が入る');
    ok(merged.every((m) => m.confidence === 'official'));

    const mail = api._mail.find((m) => m.subject.indexOf('食い違') !== -1);
    ok(mail, '食い違いを知らせるメールが出ること');
    ok(mail.body.indexOf('2026-01-28') !== -1, '手入力側の日付が書いてあること');
    ok(mail.body.indexOf('2026-01-21') !== -1, '公式側の日付が書いてあること');
  });

  test('手入力と公式が一致したら、手入力を「照合済み」に格上げする', () => {
    const same = panel(2026, [
      meetingRow('January', '27-28'), meetingRow('March', '17-18', true),
      meetingRow('April', '28-29'), meetingRow('June', '16-17', true),
      meetingRow('July', '28-29'), meetingRow('September', '15-16', true),
      meetingRow('October', '27-28'), meetingRow('December', '8-9', true),
    ]);
    const api = serving(same);
    const merged = api.allMeetings_('fomc').filter((m) => m.date.indexOf('2026') === 0);
    eq(merged.map((m) => m.date), api.MEETINGS.fomc.meetings.map((m) => m.date));
    ok(merged.every((m) => m.confidence === 'official'), '照合済みとして扱う');
    eq(api._mail.filter((m) => m.subject.indexOf('食い違') !== -1), [],
       '一致したときは黙っている');
  });

  test('同じ食い違いを何度も知らせない', () => {
    const api = serving(PAGE_HTML);
    api.allMeetings_('fomc');
    const first = api._mail.length;
    api._store._fomcAuto = '';   // キャッシュを消して取り直させる
    api.allMeetings_('fomc');
    eq(api._mail.length, first, '2回目は送らない');
  });

  test('公式ページを取れなければ、手入力は「未確定」のまま', () => {
    const api = loadGas({ UrlFetchApp: { fetch: () => { throw new Error('down'); } } });
    const merged = api.allMeetings_('fomc');
    eq(merged.length, 8);
    ok(merged.every((m) => m.confidence === 'estimated'),
       '照合できていないものを「確定」と言わない');
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

  test('手入力が先まであっても、照合のために取りに行く', () => {
    // 「足りているから見に行かない」だと、手入力が間違っていても永久に
    // 気づけない。確からしさのために毎回（キャッシュ越しに）照合する。
    let calls = 0;
    const api = loadGas({
      UrlFetchApp: {
        fetch: () => { calls++; return { getResponseCode: () => 200,
                                         getContentText: () => PAGE_HTML }; },
      },
    });
    api.MEETINGS.fomc.meetings.push({ date: '2099-12-15', sep: true });
    api.allMeetings_('fomc');
    eq(calls, 1);
  });

  test('自動取得を切れば手入力だけになる', () => {
    const api = serving(PAGE_HTML);
    api.CONFIG.providers.fomcAutoFetch = false;
    eq(api.allMeetings_('fomc').filter((m) => m.auto).length, 0);
  });

  test('新しい年を取り込んだら貼り付け用のメールを1度だけ送る', () => {
    const api = serving(PAGE_HTML);
    api.allMeetings_('fomc');
    const snippets = api._mail.filter((m) => m.subject.indexOf('自動取得しました') !== -1);
    eq(snippets.length, 1);
    ok(snippets[0].subject.indexOf('2027') !== -1);
    ok(snippets[0].body.indexOf("{ date: '2027-01-27', sep: false },") !== -1,
       '貼り付けられる形になっていること');
    api._store[api.PROP_FOMC_AUTO] = '';   // キャッシュを消して再取得させる
    api.allMeetings_('fomc');
    eq(api._mail.filter((m) => m.subject.indexOf('自動取得しました') !== -1).length, 1,
       '同じ年で二度は送らない');
  });

  test('自動取得ぶんの予定には出所が書かれる', () => {
    const api = serving(PAGE_HTML);
    const ctx = { start: Y(2027, 3, 1), end: Y(2027, 3, 31), timezone: 'Asia/Tokyo' };
    const rate = api.providerFomc_(ctx).find((e) => e.indicatorId === 'us_fomc_rate');
    eq(K(api.localDate_(rate.start, 'America/New_York')), '2027-03-17');
    eq(rate.extra.auto, true);
    ok(rate.note.indexOf('公式ページから取得') !== -1, rate.note.slice(-60));
    eq(rate.confidence, 'official', '公式ページ由来なので確定');
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

  test('出しようがない指標を、理由つきで挙げる', () => {
    const api = loadGas({ Calendar: fakeCalendar(), ScriptApp: fakeScriptApp() });
    Object.assign(api.CONFIG.providers,
      { fred: false, earnings: false, investing: false, fomcAutoFetch: false });

    const rows = api.unreachableIndicators_(true);
    const text = rows.join('\n');
    // 会合日程が空のままだと、日銀も ECB も永久に出てこない。
    ok(text.indexOf('日銀') !== -1, text);
    ok(text.indexOf('02_meetings.js') !== -1, 'どこを直せばよいか書いてあること');
    ok(text.indexOf('boj.or.jp') !== -1, '確認先の URL が載っていること');
    // 発表規則を持つ指標は、ここに挙がってはいけない。
    ok(text.indexOf('消費者物価指数') === -1, text);

    ok(api.showStatus().indexOf('この設定では出てこない指標') !== -1);
  });

  test('会合日程を入れれば、出てこない扱いから外れる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    Object.assign(api.CONFIG.providers, { fomcAutoFetch: false });
    ok(api.whyUnreachable_(api.indicator_('jp_boj_decision')) !== '');
    api.MEETINGS.boj.meetings.push({ date: '2026-09-18', sep: false });
    eq(api.whyUnreachable_(api.indicator_('jp_boj_decision')), '');
    api.MEETINGS.boj.meetings.pop();
  });

  test('情報源を切ると、その理由が出る', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    api.CONFIG.providers.rules = false;
    ok(api.whyUnreachable_(api.indicator_('us_cpi')).indexOf('providers.rules') !== -1);
    api.CONFIG.providers.rules = true;
    eq(api.whyUnreachable_(api.indicator_('us_cpi')), '');

    api.CONFIG.providers.market = false;
    ok(api.whyUnreachable_(api.indicator_('market_holiday')).indexOf('providers.market') !== -1);
  });

  test('showStatus は日程の出所を分けて表示する', () => {
    const api = loadGas({
      ScriptApp: fakeScriptApp(),
      UrlFetchApp: {
        fetch: () => ({ getResponseCode: () => 200, getContentText: () => PAGE_HTML }),
      },
    });
    const text = api.showStatus();
    ok(/2027-\d{2}-\d{2} まで \/ \d+ 件中 \d+ 件が公式と照合済み/.test(text), text);
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
    // 1日おきでも、曜日・月末・夏時間の両切替はすべて境界に来る。
    for (let offset = 0; offset < 365; offset += 2) {
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
    api.CONFIG.providers.officialTimes = false;
    api.syncCalendar();
    eq(calls, 1);
  });

  test('発表予定表も、1回の同期で同じ URL を1回しか叩かない', () => {
    const urls = [];
    const api = loadGas({
      Calendar: fakeCalendar(),
      UrlFetchApp: { fetch: (url) => { urls.push(url); throw new Error('down'); } },
    });
    Object.assign(api.CONFIG.providers,
      { fred: false, earnings: false, investing: false, fomcAutoFetch: false });
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };
    api.providerOfficial_(ctx);
    api.providerOfficial_(ctx);
    eq(urls.length, new Set(urls).size, '同じ URL を2回叩かないこと: ' + urls.join(', '));
    eq(urls.length, api.CONFIG.officialSchedules.length);
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

  test('他の国の行を、米国の指標として取り込まない', () => {
    // 設定上 EU や中国も問い合わせるので、応答には他国の行が混ざる。
    // 名前だけで名寄せすると、ユーロ圏の CPI が米 CPI の欄に入る。
    const mixed = [
      '<tr data-event-datetime="2026/09/11 09:00:00">'
      + '<td class="left flagCur noWrap">EUR</td>'
      + '<td class="left event">Core CPI (MoM)</td>'
      + '<td id="eventActual_1">9.9%</td></tr>',
      '<tr data-event-datetime="2026/09/11 01:30:00">'
      + '<td class="left flagCur noWrap">CNY</td>'
      + '<td class="left event">Chinese Manufacturing PMI</td>'
      + '<td id="eventActual_2">49.5</td></tr>',
      ROW_HTML,
    ].join('');
    const api = serving(JSON.stringify({ data: mixed }));
    api.CONFIG.filter.minImpact = 0;
    const events = api.providerInvesting_(ctx);
    const cpi = events.filter((e) => e.indicatorId === 'us_cpi');
    eq(cpi.length, 1, '米 CPI はひとつだけ');
    eq(cpi[0].actual, '0.2%', 'ユーロ圏の数値が入っていないこと');
    ok(events.every((e) => e.indicatorId !== 'us_spglobal_pmi_flash'),
       '中国 PMI が米 PMI として入っていないこと');
    eq(events.filter((e) => e.indicatorId === 'cn_pmi').length, 1,
       '中国 PMI は中国の指標として入ること');
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

// ---------------------------------------------------------------------------
suite('終日の予定にする設定', () => {
  function offline(api, allDay) {
    api.CONFIG.providers.fred = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    api.CONFIG.providers.fomcAutoFetch = false;
    api.CONFIG.display.allDay = allDay !== false;
    return api;
  }

  test('既定は時刻つき', () => {
    const api = loadGas();
    eq(api.CONFIG.display.allDay, false);
    ok(api.toCalendarResource_(event(api)).start.dateTime);
  });

  test('allDay を立てるとすべて終日になる', () => {
    const api = offline(loadGas());
    const events = api.collectEvents_({ start: Y(2026, 9, 1), end: Y(2026, 9, 30),
                                        timezone: 'Asia/Tokyo' });
    ok(events.length > 20);
    events.forEach((e) => {
      const resource = api.toCalendarResource_(e);
      eq(Object.keys(resource.start), ['date'], e.indicatorId);
      eq(resource.end.date, K(G.addDays_(G.parseDateKey_(resource.start.date), 1)));
    });
  });

  test('日付は表示タイムゾーンのもの', () => {
    const api = offline(loadGas());
    const fomc = api.collectEvents_({ start: Y(2026, 9, 1), end: Y(2026, 9, 30),
                                      timezone: 'Asia/Tokyo' })
      .find((e) => e.indicatorId === 'us_fomc_rate');
    // 9/16 14:00 ET は日本時間 9/17 未明
    eq(api.toCalendarResource_(fomc).start.date, '2026-09-17');
  });

  test('米国日付とずれるときだけ、説明文に米国日付を併記する', () => {
    const api = offline(loadGas());
    const events = api.collectEvents_({ start: Y(2026, 9, 1), end: Y(2026, 9, 30),
                                        timezone: 'Asia/Tokyo' });
    const fomc = events.find((e) => e.indicatorId === 'us_fomc_rate');
    const cpi = events.find((e) => e.indicatorId === 'us_cpi');
    ok(api.renderDescription_(fomc).indexOf('米国時間 2026/09/16') !== -1,
       'ずれるものは併記する');
    ok(api.renderDescription_(cpi).indexOf('米国時間') === -1,
       '同じ日ならわざわざ書かない');
  });

  test('一覧表示から時刻が消える', () => {
    const api = offline(loadGas());
    const line = api.renderLine_(event(api, { title: 'CPI' }));
    ok(!/\d{2}:\d{2}/.test(line), line);
    ok(line.indexOf('CPI') !== -1);
  });

  test('戻せば時刻つきになる', () => {
    const api = offline(loadGas(), false);
    const resource = api.toCalendarResource_(event(api));
    ok(resource.start.dateTime, '時刻つきになること');
    ok(/\d{2}:\d{2}/.test(api.renderLine_(event(api))), '一覧にも時刻が出ること');
  });

  test('終日に切り替えても予定は作り直されない', () => {
    // uid は「指標id@表示日」なので、表示形式を変えても同じ予定を指す。
    const timed = loadGas();
    const allDay = loadGas();
    allDay.CONFIG.display.allDay = true;
    const sample = { indicatorId: 'us_cpi', title: 'CPI', impact: 98,
                     start: G.zonedTime_(Y(2026, 9, 11), '08:30', 'America/New_York') };
    sample.end = new Date(sample.start.getTime() + 1800000);

    const a = timed.toCalendarResource_(timed.makeEvent_(sample));
    const b = allDay.toCalendarResource_(allDay.makeEvent_(sample));
    eq(a.id, b.id, '予定 ID は同じ（＝更新になる）');
    ok(a.extendedProperties.private.hash !== b.extendedProperties.private.hash,
       '中身は変わるので更新は走る');
  });

  test('もともと終日のもの（休場・週次まとめ）はそのまま', () => {
    const api = offline(loadGas());
    const holiday = api.collectEvents_({ start: Y(2026, 9, 1), end: Y(2026, 9, 30),
                                         timezone: 'Asia/Tokyo' })
      .find((e) => e.indicatorId === 'market_holiday');
    eq(api.toCalendarResource_(holiday).start.date, '2026-09-07');
    ok(api.renderDescription_(holiday).indexOf('米国時間') === -1);
  });

  test('終日でも連続実行で重複しない', () => {
    const calendar = fakeCalendar();
    const api = offline(loadGas({
      Calendar: calendar,
      properties: { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)' },
    }));
    for (let day = 0; day < 30; day++) {
      const today = G.addDays_(Y(2026, 9, 1), day);
      const ctx = { start: G.addDays_(today, -5), end: G.addDays_(today, 60),
                    timezone: 'Asia/Tokyo' };
      let events = api.collectEvents_(ctx);
      events = events.concat(api.weeklyDigestEvents_(events, ctx));
      api.applyPlan_(api.buildPlan_('c', events,
        api.listManagedEvents_('c', ctx.start, ctx.end), ctx));
    }
    const byUid = {};
    [...calendar.events.values()].forEach((item) => {
      const uid = item.extendedProperties.private.uid;
      byUid[uid] = (byUid[uid] || 0) + 1;
    });
    eq(Object.entries(byUid).filter((pair) => pair[1] > 1), []);
  });
});

// ---------------------------------------------------------------------------
suite('発表時刻の出どころ', () => {
  const day = Y(2026, 9, 11);
  const at = (hhmm) => G.zonedTime_(day, hhmm, 'America/New_York');
  const make = (api, over) => api.makeEvent_(Object.assign({
    indicatorId: 'us_cpi', title: 'CPI', impact: 98,
    start: at('08:30'), end: at('09:00'),
  }, over));

  test('FRED は発表日しか持たないので、時刻はカタログの慣例値になる', () => {
    const api = loadGas({
      properties: { FRED_API_KEY: 'k' },
      UrlFetchApp: {
        fetch: () => ({
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            count: 1,
            release_dates: [{ release_id: 10, release_name: 'Consumer Price Index',
                              date: '2026-09-11' }],
          }),
        }),
      },
    });
    const found = api.providerFred_({ start: Y(2026, 9, 1), end: Y(2026, 9, 30),
                                      timezone: 'Asia/Tokyo' })[0];
    eq(api.formatClock_(found.start, 'America/New_York').time, '08:30');
    eq(found.exactTime, false, '慣例値であることを記録しておく');
  });

  test('Investing は実際の発表時刻を持つ', () => {
    const html = '<tr data-event-datetime="2026/09/11 12:45:00">'
      + '<td class="left event">Core CPI (MoM)</td></tr>';
    const events = G.investingRowsToEvents_(G.parseInvestingRows_(html),
      { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' });
    eq(events[0].exactTime, true);
  });

  test('日付は FRED、時刻は実測値、という取り方になる', () => {
    const api = loadGas();
    const fromFred = make(api, { source: 'fred' });
    const fromSite = make(api, { source: 'investing', exactTime: true,
                                 forecast: '0.3%', start: at('08:45'), end: at('09:15') });
    const merged = api.mergeEvent_(fromFred, fromSite);
    eq(merged.source, 'fred', '日付の確度は FRED を採る');
    eq(api.formatClock_(merged.start, 'America/New_York').time, '08:45',
       '時刻は実測値に譲る');
    eq(merged.forecast, '0.3%');
  });

  test('合成の順番によらず同じ結果になる', () => {
    const api = loadGas();
    const a = make(api, { source: 'fred' });
    const b = make(api, { source: 'investing', exactTime: true, start: at('08:45'),
                          end: at('09:15') });
    eq(api.mergeEvent_(a, b).start.toISOString(), api.mergeEvent_(b, a).start.toISOString());
  });

  test('どちらも慣例値なら優先順位どおり', () => {
    const api = loadGas();
    const rules = make(api, { source: 'rules', start: at('09:00'), end: at('09:30') });
    const fred = make(api, { source: 'fred' });
    eq(api.formatClock_(api.mergeEvent_(rules, fred).start, 'America/New_York').time,
       '08:30');
  });

  test('時刻の出どころを、そのまま説明文に書く', () => {
    const api = loadGas();
    // 一次情報から来た時刻には何も断らない。それが当たり前だから。
    const official = api.renderDescription_(
      make(api, { source: 'official', timeSource: 'official' }));
    ok(official.indexOf('時刻の根拠 発表機関の予定表') !== -1, official);
    ok(official.indexOf('暫定値') === -1, official);

    // 集計サイト由来は、そうと書く。
    const site = api.renderDescription_(
      make(api, { source: 'investing', timeSource: 'reported' }));
    ok(site.indexOf('集計サイト由来') !== -1, site);

    // カタログの値をそのまま当てただけのものは「未確認」と言い切る。
    const guess = api.renderDescription_(make(api, { source: 'fred' }));
    ok(guess.indexOf('未確認の暫定値') !== -1, guess);
  });

  test('終日にしたときは時刻の話をしない', () => {
    const api = loadGas();
    api.CONFIG.display.allDay = true;
    const text = api.renderDescription_(make(api, { source: 'fred' }));
    ok(text.indexOf('暫定値') === -1, text);
    ok(text.indexOf('時刻の根拠') === -1, text);
  });

  test('Investing を有効にすると、時刻も数値も入った予定になる', () => {
    const html = '<tr data-event-datetime="2026/09/11 12:45:00">'
      + '<td class="left event"><a href="/x">Core CPI (MoM)&nbsp;<span>(Aug)</span></a></td>'
      + '<td id="eventActual_1">0.2%</td><td id="eventForecast_1">0.3%</td>'
      + '<td id="eventPrevious_1">0.4%</td></tr>';
    const api = loadGas({
      properties: { FRED_API_KEY: 'k' },
      UrlFetchApp: {
        fetch: (url) => ({
          getResponseCode: () => 200,
          getContentText: () => (url.indexOf('stlouisfed') !== -1
            ? JSON.stringify({ count: 1, release_dates: [
                { release_id: 10, release_name: 'Consumer Price Index',
                  date: '2026-09-11' }] })
            : JSON.stringify({ data: html })),
        }),
      },
    });
    api.CONFIG.providers.rules = false;
    api.CONFIG.providers.fomc = false;
    api.CONFIG.providers.market = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.fomcAutoFetch = false;
    api.CONFIG.providers.investing = true;

    const events = api.collectEvents_({ start: Y(2026, 9, 1), end: Y(2026, 9, 30),
                                        timezone: 'Asia/Tokyo' });
    const cpi = events.find((e) => e.indicatorId === 'us_cpi');
    eq(api.formatClock_(cpi.start, 'America/New_York').time, '08:45', '実測の時刻');
    eq([cpi.forecast, cpi.previous, cpi.actual], ['0.3%', '0.4%', '0.2%']);
    eq(cpi.confidence, 'official');
  });
});

// ---------------------------------------------------------------------------
suite('日付の根拠を偽らない', () => {
  function offline(api) {
    api.CONFIG.providers.fred = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    api.CONFIG.providers.fomcAutoFetch = false;
    return api;
  }

  test('根拠を書かなければ「概算」に倒れる', () => {
    // 指定し忘れたときに「確定」と名乗ってしまうのが一番まずい。
    const bare = G.makeEvent_({ indicatorId: 'x', title: 'x', impact: 50,
                                start: new Date(1), end: new Date(2) });
    eq(bare.confidence, 'estimated');
  });

  test('知らない根拠名も「概算」に倒れる', () => {
    const bogus = G.makeEvent_({ indicatorId: 'x', title: 'x', impact: 50,
                                 confidence: 'とても確か',
                                 start: new Date(1), end: new Date(2) });
    eq(bogus.confidence, 'estimated');
  });

  test('情報源ごとに名乗ってよい根拠が決まっている', () => {
    const allowed = {
      rules: ['rule', 'estimated'],
      market: ['rule'],
      fomc: ['official', 'rule', 'estimated'],
      fred: ['official'],
      earnings: ['official'],
      investing: ['reported'],
      digest: ['rule', 'estimated', 'official', 'reported'],
    };
    const api = offline(loadGas());
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 10, 31), timezone: 'Asia/Tokyo' };
    api.collectEvents_(ctx).forEach((e) => {
      ok(allowed[e.source] && allowed[e.source].indexOf(e.confidence) !== -1,
         e.indicatorId + ': ' + e.source + ' が ' + e.confidence + ' を名乗っている');
    });
  });

  test('通信なしのときに「公式」を名乗る予定は1件も無い', () => {
    const api = offline(loadGas());
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 12, 31), timezone: 'Asia/Tokyo' };
    const claimed = api.collectEvents_(ctx).filter((e) => e.confidence === 'official');
    eq(claimed.map((e) => e.indicatorId), [],
       '外部から何も取っていないのに公式を名乗ってはいけない');
  });

  test('件名の「予定日未確定」は概算のときだけ', () => {
    ['official', 'reported', 'rule'].forEach((level) => {
      ok(G.renderTitle_(event(G, { confidence: level })).indexOf('予定日未確定') === -1,
         level);
    });
    ok(G.renderTitle_(event(G, { confidence: 'estimated' })).indexOf('予定日未確定') !== -1);
  });

  test('説明文には必ず根拠が書いてある', () => {
    ['official', 'reported', 'rule', 'estimated'].forEach((level) => {
      const text = G.renderDescription_(event(G, { confidence: level }));
      ok(text.indexOf('日付の根拠 ' + G.CONFIDENCE_LABEL[level]) !== -1, level);
    });
  });

  test('根拠が変われば内容ハッシュも変わる（既存の予定が更新される）', () => {
    const a = G.eventContentHash_(event(G, { confidence: 'estimated' }));
    const b = G.eventContentHash_(event(G, { confidence: 'official' }));
    ok(a !== b);
  });
});

// ---------------------------------------------------------------------------
suite('データ品質の点検', () => {
  function offline(api) {
    api.CONFIG.providers.fred = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    api.CONFIG.providers.fomcAutoFetch = false;
    return api;
  }

  test('根拠の内訳と、確かさを上げる手順を出す', () => {
    const api = offline(loadGas({ Calendar: fakeCalendar(), ScriptApp: fakeScriptApp() }));
    const text = api.dataQuality();
    ['日付の根拠', '概算（未確定）', 'FOMC 会合日程', '確かさを上げるには',
     'FRED_API_KEY', '影響度スコアと解説文は、データではなく']
      .forEach((needle) => ok(text.indexOf(needle) !== -1, needle));
  });

  test('未確定の指標を名前で挙げる', () => {
    const api = offline(loadGas({ Calendar: fakeCalendar(), ScriptApp: fakeScriptApp() }));
    const text = api.dataQuality();
    ok(text.indexOf('米 消費者物価指数 (CPI)') !== -1, 'CPI は概算なので挙がるはず');
  });

  test('FRED キーがあれば、その手順は「設定済み」になる', () => {
    const api = offline(loadGas({
      Calendar: fakeCalendar(), ScriptApp: fakeScriptApp(),
      properties: { FRED_API_KEY: 'k' },
    }));
    const text = api.dataQuality();
    ok(text.indexOf('✅ FRED キーは設定済み') !== -1);
  });

  test('FOMC を照合できていないことを隠さない', () => {
    const api = offline(loadGas({ Calendar: fakeCalendar(), ScriptApp: fakeScriptApp() }));
    ok(api.dataQuality().indexOf('未照合') !== -1);
  });

  test('照合できていれば、そう出る', () => {
    const { panel, meetingRow } = require('./fomc-fixture');
    const same = panel(2026, [
      meetingRow('January', '27-28'), meetingRow('March', '17-18', true),
      meetingRow('April', '28-29'), meetingRow('June', '16-17', true),
      meetingRow('July', '28-29'), meetingRow('September', '15-16', true),
      meetingRow('October', '27-28'), meetingRow('December', '8-9', true),
    ]);
    const api = loadGas({
      Calendar: fakeCalendar(), ScriptApp: fakeScriptApp(),
      UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200,
                                     getContentText: () => same }) },
    });
    api.CONFIG.providers.fred = false;
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    ok(api.dataQuality().indexOf('照合済み') !== -1);
  });
});

// ---------------------------------------------------------------------------
suite('発表規則の当たり具合を測る', () => {
  function serving(rows) {
    return loadGas({
      Calendar: fakeCalendar(), ScriptApp: fakeScriptApp(),
      properties: { FRED_API_KEY: 'k' },
      UrlFetchApp: {
        fetch: () => ({
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ count: rows.length,
                                                 release_dates: rows }),
        }),
      },
    });
  }

  test('キーが無ければ、その旨を返して終わる', () => {
    const api = loadGas({ Calendar: fakeCalendar(), ScriptApp: fakeScriptApp() });
    ok(api.verifyRules().indexOf('FRED のキーが必要') !== -1);
  });

  test('実際の発表日と規則のずれを出す', () => {
    // 失業保険は毎週木曜。木曜の日付を並べればずれ 0 になるはず。
    const rows = ['2026-08-06', '2026-08-13', '2026-08-20', '2026-08-27'].map((date) => ({
      release_id: 1, release_name: 'Unemployment Insurance Weekly Claims', date,
    }));
    const text = serving(rows).verifyRules();
    ok(text.indexOf('新規失業保険申請件数') !== -1, text);
    ok(/0 日\s+100%/.test(text), 'ぴったり当たっていること: ' + text);
  });

  test('ずれている規則はずれとして出る', () => {
    // CPI の規則は「12日ごろ」。20日に寄せた日付を並べればずれが出る。
    const rows = ['2026-06-20', '2026-07-20', '2026-08-20'].map((date) => ({
      release_id: 10, release_name: 'Consumer Price Index', date,
    }));
    const text = serving(rows).verifyRules();
    ok(text.indexOf('消費者物価指数') !== -1, text);
    ok(!/ 0 日\s+100%.*消費者物価/.test(text), 'ぴったりとは出ないこと');
  });

  test('突き合わせるものが無ければ、そう言う', () => {
    const rows = [{ release_id: 99, release_name: 'Cheese Price Index',
                    date: '2026-08-06' }];
    ok(serving(rows).verifyRules().indexOf('突き合わせられる実績がありません') !== -1);
  });

  test('規則を持たない指標は測らない（FOMC など）', () => {
    eq(G.ruleDistanceDays_(G.indicator_('us_fomc_rate'), Y(2026, 9, 16)), null);
    eq(G.ruleDistanceDays_(G.indicator_('us_cpi'), Y(2026, 9, 14)), 0);
  });
});

// ---------------------------------------------------------------------------
suite('FRED の対応付けの誤りを見つける', () => {
  function serving(rows) {
    return loadGas({
      properties: { FRED_API_KEY: 'k' },
      UrlFetchApp: {
        fetch: () => ({
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ count: rows.length,
                                                 release_dates: rows }),
        }),
      },
    });
  }
  const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };

  test('ひとつの指標に複数の release が当たったら知らせる', () => {
    const api = serving([
      { release_id: 1, release_name: 'Producer Price Index', date: '2026-09-11' },
      { release_id: 2, release_name: 'Producer Price Index by Commodity',
        date: '2026-09-25' },
    ]);
    api.providerFred_(ctx);
    const warnings = api.fredMatchWarnings_();
    eq(warnings.length, 1);
    ok(warnings[0].indexOf('us_ppi') !== -1, warnings[0]);
    ok(warnings[0].indexOf('2 種類') !== -1, warnings[0]);
  });

  test('正しく1種類なら黙っている', () => {
    const api = serving([
      { release_id: 10, release_name: 'Consumer Price Index', date: '2026-09-11' },
      { release_id: 10, release_name: 'Consumer Price Index', date: '2026-10-13' },
    ]);
    api.providerFred_(ctx);
    eq(api.fredMatchWarnings_(), []);
  });

  test('疑いはデータ品質の点検にも出る', () => {
    const api = loadGas({
      Calendar: fakeCalendar(), ScriptApp: fakeScriptApp(),
      properties: { FRED_API_KEY: 'k' },
      UrlFetchApp: {
        fetch: () => ({
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ count: 2, release_dates: [
            { release_id: 1, release_name: 'Producer Price Index', date: '2026-09-11' },
            { release_id: 2, release_name: 'Producer Price Index by Commodity',
              date: '2026-09-25' }] }),
        }),
      },
    });
    api.CONFIG.providers.earnings = false;
    api.CONFIG.providers.investing = false;
    api.CONFIG.providers.fomcAutoFetch = false;
    ok(api.dataQuality().indexOf('対応付けに疑いあり') !== -1);
  });
});

// ---------------------------------------------------------------------------
suite('回帰: 名前が同じ指標に別の数値が入る', () => {
  test('ミシガン大の速報値と確報値を発表日で見分ける', () => {
    // どちらも「Michigan Consumer Sentiment」で出てくることがある。
    // 名前だけで決めると、確報値の数字が速報値の予定に入ってしまう。
    eq(G.matchEventName_('Michigan Consumer Sentiment',
                         Y(2026, 9, 11)).id, 'us_umich_prelim', '第2金曜は速報');
    eq(G.matchEventName_('Michigan Consumer Sentiment',
                         Y(2026, 9, 25)).id, 'us_umich_final', '最終金曜は確報');
    eq(G.matchEventName_('Michigan Consumer Sentiment',
                         Y(2026, 10, 9)).id, 'us_umich_prelim');
    eq(G.matchEventName_('Michigan Consumer Sentiment',
                         Y(2026, 10, 30)).id, 'us_umich_final');
  });

  test('Investing の取り込みでも見分けられる', () => {
    const row = (date) => '<tr data-event-datetime="' + date + ' 14:00:00">'
      + '<td class="left event">Michigan Consumer Sentiment</td>'
      + '<td id="eventActual_1">55.1</td></tr>';
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };
    const prelim = G.investingRowsToEvents_(
      G.parseInvestingRows_(row('2026/09/11')), ctx);
    const final = G.investingRowsToEvents_(
      G.parseInvestingRows_(row('2026/09/25')), ctx);
    eq(prelim[0].indicatorId, 'us_umich_prelim');
    eq(final[0].indicatorId, 'us_umich_final');
  });

  test('名前が1指標にしか当たらないものは従来どおり', () => {
    [['Core CPI (MoM) (Aug)', 'us_cpi'], ['ISM Non-Manufacturing PMI', 'us_ism_services'],
     ['Fed Chair Powell Speaks', 'us_fed_speech'], ['Nonfarm Payrolls', 'us_nfp'],
     ['ADP Nonfarm Employment Change', 'us_adp']].forEach((pair) => {
      eq(G.matchEventName_(pair[0], Y(2026, 9, 11)).id, pair[1], pair[0]);
      eq(G.matchEventName_(pair[0]).id, pair[1], pair[0] + '（日付なしでも）');
    });
  });

  test('名寄せパターンを共有する指標は、発表日で必ず見分けられること', () => {
    // 将来パターンを足したときに、区別できない組を作らないための歯止め。
    const byPattern = {};
    G.INDICATORS.forEach((indicator) => {
      (indicator.match || []).forEach((pattern) => {
        (byPattern[pattern] = byPattern[pattern] || []).push(indicator);
      });
    });
    Object.keys(byPattern).forEach((pattern) => {
      const shared = byPattern[pattern];
      if (shared.length < 2) return;
      shared.forEach((indicator) => {
        ok(indicator.schedule && indicator.schedule.type
           && indicator.schedule.type !== 'none',
           pattern + ' を共有する ' + indicator.id + ' に発表規則が無い（見分けられない）');
      });
      // 予想日が十分に離れていること
      const dates = shared.map((indicator) => G.ruleDates_(
        indicator.schedule, Y(2026, 9, 1), Y(2026, 9, 30)).map(K).join(','));
      eq(new Set(dates).size, dates.length,
         pattern + ' を共有する指標の予想日が重なっている');
    });
  });

  test('FRED の release パターンどうしが衝突しない', () => {
    const withFred = G.INDICATORS.filter((i) => i.fred_release);
    withFred.forEach((a) => {
      withFred.forEach((b) => {
        if (a.id >= b.id) return;
        [a.fred_release, b.fred_release].forEach((pattern) => {
          const sample = pattern.replace(/[\^\$]/g, '');
          const hitA = new RegExp(a.fred_release, 'i').test(sample);
          const hitB = new RegExp(b.fred_release, 'i').test(sample);
          ok(!(hitA && hitB),
             '「' + sample + '」に ' + a.id + ' と ' + b.id + ' の両方が当たる');
        });
      });
    });
  });
});

// ---------------------------------------------------------------------------
suite('回帰: 回線の不調で予定の日付が動く', () => {
  const FRED_ROWS = [{ release_id: 10, release_name: 'Consumer Price Index',
                       date: '2026-09-11' }];

  function cpiOnly(calendar, fredWorks) {
    const api = loadGas({
      Calendar: calendar,
      properties: Object.assign({ _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)' },
                                fredWorks ? { FRED_API_KEY: 'k' } : {}),
      UrlFetchApp: {
        fetch: (url) => {
          if (url.indexOf('stlouisfed') === -1 || !fredWorks) throw new Error('down');
          return { getResponseCode: () => 200,
                   getContentText: () => JSON.stringify({ count: 1,
                                                          release_dates: FRED_ROWS }) };
        },
      },
    });
    Object.assign(api.CONFIG.providers, { earnings: false, investing: false,
                                          fomcAutoFetch: false, market: false, fomc: false });
    api.CONFIG.filter.include = ['us_cpi'];
    api.CONFIG.filter.minImpact = 101;   // CPI だけを見る
    return api;
  }

  function sync(calendar, fredWorks) {
    const api = cpiOnly(calendar, fredWorks);
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };
    const plan = api.buildPlan_('c', api.collectEvents_(ctx),
                                api.listManagedEvents_('c', ctx.start, ctx.end), ctx);
    api.applyPlan_(plan);
    return plan;
  }

  function stored(calendar) {
    const item = [...calendar.events.values()][0];
    return item && {
      date: (item.start.dateTime || item.start.date).slice(0, 10),
      confidence: item.extendedProperties.private.confidence,
    };
  }

  test('公式の日付で置いたあとは、取得に失敗しても動かない', () => {
    const calendar = fakeCalendar();
    sync(calendar, false);
    eq(stored(calendar), { date: '2026-09-14', confidence: 'estimated' },
       '最初は概算で置く');
    sync(calendar, true);
    eq(stored(calendar), { date: '2026-09-11', confidence: 'official' },
       '公式が来たら置き換わる');

    sync(calendar, false);
    eq(stored(calendar), { date: '2026-09-11', confidence: 'official' },
       '取得に失敗しても概算に戻さない');
    sync(calendar, false);
    sync(calendar, false);
    eq(stored(calendar), { date: '2026-09-11', confidence: 'official' });
    eq(calendar.events.size, 1, '重複もしない');
  });

  test('不調が続いても書き込みが発生しない', () => {
    const calendar = fakeCalendar();
    sync(calendar, false);
    sync(calendar, true);
    calendar.calls.length = 0;
    [false, false, true, false, true].forEach((works) => sync(calendar, works));
    eq(calendar.calls.filter((c) => c[0] !== 'events.list').length, 0,
       '回線が揺れても API を叩かない');
  });

  test('公式の日付が本当に変わったときは、ちゃんと動く', () => {
    const calendar = fakeCalendar();
    sync(calendar, true);
    eq(stored(calendar).date, '2026-09-11');
    FRED_ROWS[0].date = '2026-09-17';   // 発表日が延期された
    sync(calendar, true);
    eq(stored(calendar), { date: '2026-09-17', confidence: 'official' },
       '公式どうしの変更は反映する');
    FRED_ROWS[0].date = '2026-09-11';   // 後始末
  });

  test('根拠が同じなら、記憶より新しい方を採る', () => {
    // 弱い予定を止めるのは「より確かな予定がある」ときだけ。
    const api = loadGas({ Calendar: fakeCalendar() });
    const older = api.toCalendarResource_(event(api, {
      indicatorId: 'us_cpi', confidence: 'rule',
      start: api.zonedTime_(Y(2026, 9, 14), '08:30', 'America/New_York') }));
    const existing = [{ id: older.id, start: older.start, end: older.end,
                        extendedProperties: older.extendedProperties }];
    const newer = event(api, { indicatorId: 'us_cpi', confidence: 'rule',
      start: api.zonedTime_(Y(2026, 9, 11), '08:30', 'America/New_York') });
    const plan = api.buildPlan_('c', [newer], existing,
                                { start: Y(2026, 9, 1), end: Y(2026, 9, 30),
                                  timezone: 'Asia/Tokyo' });
    eq(plan.created.length, 1, '同格なら新しい方に差し替える');
    eq(plan.deleted.length, 1);
  });

  test('離れた日付の予定は記憶として使わない（別の発表なので）', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const lastMonth = api.toCalendarResource_(event(api, {
      indicatorId: 'us_cpi', confidence: 'official',
      start: api.zonedTime_(Y(2026, 8, 12), '08:30', 'America/New_York') }));
    const existing = [{ id: lastMonth.id, start: lastMonth.start, end: lastMonth.end,
                        extendedProperties: lastMonth.extendedProperties }];
    const thisMonth = event(api, { indicatorId: 'us_cpi', confidence: 'estimated',
      start: api.zonedTime_(Y(2026, 9, 14), '08:30', 'America/New_York') });
    const plan = api.buildPlan_('c', [thisMonth], existing,
                                { start: Y(2026, 8, 1), end: Y(2026, 9, 30),
                                  timezone: 'Asia/Tokyo' });
    eq(plan.created.length, 1, '先月の予定は今月の判断に使わない');
  });

  test('根拠は予定に記録される（次回の判断材料になる）', () => {
    const resource = G.toCalendarResource_(event(G, { confidence: 'official' }));
    eq(resource.extendedProperties.private.confidence, 'official');
  });
});

// ---------------------------------------------------------------------------
suite('回帰: 情報源が落ちると中身が消える', () => {
  const INV_ROW = '<tr data-event-datetime="2026/09/11 12:45:00">'
    + '<td class="left event">Core CPI (MoM)</td>'
    + '<td id="eventActual_1">0.2%</td><td id="eventForecast_1">0.3%</td></tr>';
  const FRED_ROWS = [{ release_id: 10, release_name: 'Consumer Price Index',
                       date: '2026-09-11' }];

  function api(calendar, store, up) {
    const built = loadGas({
      Calendar: calendar,
      properties: store,
      UrlFetchApp: {
        fetch: (url) => {
          const which = url.indexOf('stlouisfed') !== -1 ? 'fred' : 'inv';
          if (!up[which]) throw new Error('down');
          return { getResponseCode: () => 200, getContentText: () => (which === 'fred'
            ? JSON.stringify({ count: 1, release_dates: FRED_ROWS })
            : JSON.stringify({ data: INV_ROW })) };
        },
      },
    });
    Object.assign(built.CONFIG.providers, { earnings: false, investing: true,
                                            fomcAutoFetch: false, market: false, fomc: false });
    built.CONFIG.filter.include = ['us_cpi'];
    built.CONFIG.filter.minImpact = 101;
    return built;
  }

  function sync(calendar, store, up) {
    const built = api(calendar, store, up);
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };
    const existing = built.listManagedEvents_('c', ctx.start, ctx.end);
    const enriched = built.inheritFromExisting_(built.collectEvents_(ctx), existing);
    const plan = built.buildPlan_('c', enriched, existing, ctx);
    built.applyPlan_(plan);
    Object.keys(built._store).forEach((k) => { store[k] = built._store[k]; });
    return plan;
  }

  // カレンダーに書き込む dateTime は UTC の ISO 文字列。
  // この題材では Investing の時刻を UTC として読むので（investingAssumeTz）、
  // 12:45 はそのまま 12:45Z ＝ 日本時間 21:45、表示日は 9/11 のまま。
  function held(calendar) {
    const item = [...calendar.events.values()][0];
    const props = item.extendedProperties.private;
    return { at: item.start.dateTime,
             forecast: props.f, actual: props.a, exact: props.exact };
  }

  const HELD = { at: '2026-09-11T12:45:00.000Z', forecast: '0.3%',
                 actual: '0.2%', exact: '1' };

  test('実測時刻と発表された数値は、情報源が落ちても消えない', () => {
    const calendar = fakeCalendar();
    const store = { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)', FRED_API_KEY: 'k' };
    sync(calendar, store, { fred: true, inv: true });
    eq(calendar.events.size, 1, '対象は CPI ひとつだけ');
    eq(held(calendar), HELD, '慣例値 12:30Z ではなく実測の 12:45Z が入る');

    const plan = sync(calendar, store, { fred: true, inv: false });
    eq(held(calendar), HELD, 'Investing が落ちても中身を保つ');
    eq(plan.created.length + plan.updated.length + plan.deleted.length, 0,
       '書き込みも発生しない');
  });

  test('両方落ちても、日付も時刻も数値も消えない', () => {
    const calendar = fakeCalendar();
    const store = { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)', FRED_API_KEY: 'k' };
    sync(calendar, store, { fred: true, inv: true });
    const plan = sync(calendar, store, { fred: false, inv: false });
    eq(held(calendar), HELD, '規則だけになっても据え置く');
    eq(plan.created.length + plan.updated.length + plan.deleted.length, 0,
       '書き込みも発生しない');
  });

  test('新しい値が来たら、ちゃんと上書きする', () => {
    const calendar = fakeCalendar();
    const store = { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)', FRED_API_KEY: 'k' };
    sync(calendar, store, { fred: true, inv: true });
    eq(held(calendar).actual, '0.2%');

    const built = api(calendar, store, { fred: true, inv: true });
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };
    const existing = built.listManagedEvents_('c', ctx.start, ctx.end);
    const fresh = built.collectEvents_(ctx).map((e) => Object.assign({}, e, { actual: '0.4%' }));
    const enriched = built.inheritFromExisting_(fresh, existing);
    eq(enriched[0].actual, '0.4%', '記憶より新しい値を優先する');
  });

  test('説明文は、どのモジュールが勝ったかで変わらない', () => {
    // 情報源が入れ替わっただけで説明文が変わると、更新が走り続ける。
    const base = { indicatorId: 'us_cpi', title: 'CPI', impact: 98,
                   confidence: 'official', exactTime: true,
                   start: new Date(Date.UTC(2026, 8, 11, 12, 30)),
                   end: new Date(Date.UTC(2026, 8, 11, 13, 0)) };
    const fromFred = G.renderDescription_(G.makeEvent_(
      Object.assign({}, base, { source: 'fred' })));
    const fromSite = G.renderDescription_(G.makeEvent_(
      Object.assign({}, base, { source: 'investing' })));
    eq(fromFred, fromSite);
  });
});

// ---------------------------------------------------------------------------
suite('週次まとめは、実際にカレンダーにあるものから作る', () => {
  test('据え置いた予定を読み戻せる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const original = event(api, { indicatorId: 'us_cpi', confidence: 'official',
                                  forecast: '0.3%', actual: '0.2%', exactTime: true,
                                  start: api.zonedTime_(Y(2026, 9, 11), '08:30',
                                                        'America/New_York') });
    const resource = api.toCalendarResource_(original);
    const restored = api.eventFromResource_({
      id: resource.id, summary: resource.summary, start: resource.start,
      end: resource.end, extendedProperties: resource.extendedProperties });

    eq(restored.indicatorId, 'us_cpi');
    eq(restored.confidence, 'official');
    eq([restored.forecast, restored.actual], ['0.3%', '0.2%']);
    eq(restored.start.toISOString(), original.start.toISOString());
    eq(restored.impact, original.impact);
  });

  test('終日の予定も読み戻せる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const holiday = event(api, { indicatorId: 'market_holiday', impact: 60,
                                 allDay: true, confidence: 'rule' });
    const resource = api.toCalendarResource_(holiday);
    const restored = api.eventFromResource_({
      id: resource.id, summary: resource.summary, start: resource.start,
      end: resource.end, extendedProperties: resource.extendedProperties });
    ok(restored.allDay);
    eq(K(api.localDate_(restored.start, 'Asia/Tokyo')),
       K(api.localDate_(holiday.start, 'Asia/Tokyo')));
  });

  test('カタログに無い指標（決算）でも落ちない', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const restored = api.eventFromResource_({
      id: 'ecx', summary: '🔴 🇺🇸 NVDA 決算発表 (引け後)',
      start: { dateTime: '2026-11-19T06:15:00+09:00' },
      end: { dateTime: '2026-11-19T06:45:00+09:00' },
      extendedProperties: { private: { ecal: '1', indicator: 'earnings_NVDA',
                                       impact: '95', confidence: 'official' } },
    });
    ok(restored);
    eq(restored.impact, 95);
    eq(restored.indicatorId, 'earnings_NVDA');
  });

  test('壊れた予定を読み戻そうとしても落ちない', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    eq(api.eventFromResource_({ id: 'x', start: { dateTime: 'めちゃくちゃ' },
                                end: { dateTime: 'めちゃくちゃ' },
                                extendedProperties: { private: {} } }), null);
  });

  test('据え置いた予定が、まとめの一覧に残る', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    Object.assign(api.CONFIG.providers, { fred: false, earnings: false,
                                          investing: false, fomcAutoFetch: false });
    // カレンダーには公式の 9/11、今回の計算では概算の 9/14 が出る状況
    const official = event(api, { indicatorId: 'us_cpi', impact: 98, confidence: 'official',
      start: api.zonedTime_(Y(2026, 9, 11), '08:30', 'America/New_York') });
    const resource = api.toCalendarResource_(official);
    const existing = [{ id: resource.id, summary: resource.summary, start: resource.start,
                        end: resource.end,
                        extendedProperties: resource.extendedProperties }];
    const weak = event(api, { indicatorId: 'us_cpi', impact: 98, confidence: 'estimated',
      start: api.zonedTime_(Y(2026, 9, 14), '08:30', 'America/New_York') });

    const shown = api.displayEvents_([weak], existing);
    eq(shown.length, 1);
    eq(K(api.localDate_(shown[0].start, 'Asia/Tokyo')), '2026-09-11',
       'カレンダーにある方が一覧に出ること');
    eq(shown[0].confidence, 'official');
  });
});

// ---------------------------------------------------------------------------
// 8周目: コードを1行ずつ読んで見つけたもの。
// ---------------------------------------------------------------------------
suite('SQ は、市場が閉まっている日に置かない', () => {
  // オプションの満期は原則そのうきの第3金曜だが、その日が休場なら前営業日に
  // 繰り上がる。2026-06-19（ジューンティーンス）が実際にそれに当たる。
  test('第3金曜が休場なら、前営業日に繰り上げる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    [[2025, 4, '2025-04-17'], [2026, 6, '2026-06-18'], [2027, 6, '2027-06-17'],
     [2030, 4, '2030-04-18'], [2033, 4, '2033-04-14']].forEach((row) => {
      eq(K(api.expiryDay_(row[0], row[1])), row[2], row[0] + '-' + row[1]);
    });
  });

  test('ふつうの月は第3金曜のまま', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    [[2026, 3, '2026-03-20'], [2026, 9, '2026-09-18'], [2026, 12, '2026-12-18']]
      .forEach((row) => eq(K(api.expiryDay_(row[0], row[1])), row[2]));
  });

  test('満期日が休場と重ならない（20年ぶん）', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    for (let y = 2024; y <= 2044; y++) {
      const holidays = api.marketHolidays_(y);
      for (let m = 1; m <= 12; m++) {
        const day = api.expiryDay_(y, m);
        ok(!holidays[K(day)], K(day) + ' は休場');
        ok(api.weekdayOf_(day) < 5, K(day) + ' は週末');
      }
    }
  });

  test('カレンダーに入る SQ も繰り上がっている', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    api.CONFIG.filter.minImpact = 0;
    const ctx = { start: Y(2026, 6, 1), end: Y(2026, 6, 30), timezone: 'Asia/Tokyo' };
    const quad = api.providerMarket_(ctx).find(
      (e) => e.indicatorId === 'market_quad_witching');
    ok(quad, 'クアドラプル・ウィッチングが出ること');
    eq(K(api.localDate_(quad.start, 'America/New_York')), '2026-06-18',
       'ジューンティーンス（6/19）ではなく前日に置くこと');
  });
});

// ---------------------------------------------------------------------------
suite('据え置きの相手は、いちばん近いものを選ぶ', () => {
  function weekly(api, day, confidence, source) {
    return api.makeEvent_({
      indicatorId: 'us_jobless_claims', title: '米 新規失業保険申請件数', impact: 75,
      source: source, confidence: confidence,
      start: api.zonedTime_(Y(2026, 9, day), '08:30', 'America/New_York'),
      end: api.zonedTime_(Y(2026, 9, day), '08:45', 'America/New_York'),
    });
  }
  function stored(api, events) {
    return events.map((e) => {
      const r = api.toCalendarResource_(e);
      return { id: r.id, summary: r.summary, start: r.start, end: r.end,
               extendedProperties: r.extendedProperties };
    });
  }

  test('毎週の指標で、隣の週を掴まない', () => {
    // 失業保険は毎週なので、12日以内に必ず別の週がいる。最初に見つかった
    // ものを採ると隣の週を守ってしまい、守るべき方の予定が消える。
    const api = loadGas({ Calendar: fakeCalendar() });
    const existing = stored(api, [4, 11, 18, 25].map(
      (d) => weekly(api, d, 'official', 'fred')));
    const fresh = [3, 10, 17, 24].map((d) => weekly(api, d, 'rule', 'rules'));

    const guarded = api.keepStrongerExisting_(fresh, existing);
    eq(guarded.events.length, 0, '弱い方は全部捨てる');
    eq(Object.keys(guarded.keptIds).length, 4, '公式の4週ぶんすべてを守ること');

    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };
    const plan = api.buildPlan_('c', fresh, existing, ctx);
    eq(plan.deleted.length, 0, '1件も消さないこと');
  });

  test('同じものを二度「据え置き」と数えない', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const existing = stored(api, [[10, 'official']].map(
      (r) => weekly(api, r[0], r[1], 'fred')));
    const fresh = [9, 11].map((d) => weekly(api, d, 'rule', 'rules'));
    const guarded = api.keepStrongerExisting_(fresh, existing);
    eq(guarded.replaced.length, new Set(guarded.replaced).size,
       'まとめの一覧に同じ予定が二度出ないこと');
    eq(api.displayEvents_(fresh, existing).length, 1);
  });
});

// ---------------------------------------------------------------------------
suite('知らせと表示が、静かに嘘をつかない', () => {
  function ready(overrides) {
    const api = loadGas(Object.assign({
      Calendar: fakeCalendar(),
      properties: { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)' },
      UrlFetchApp: { fetch: () => { throw new Error('down'); },
                     fetchAll: (rs) => rs.map(() => ({ getResponseCode: () => 503,
                                                       getContentText: () => '' })) },
    }, overrides));
    Object.assign(api.CONFIG.providers, { fred: false, earnings: false, investing: false,
                                          fomcAutoFetch: false, officialTimes: false });
    return api;
  }

  test('通知の控えが保存できなくても、同期は成功のまま', () => {
    // ここで例外が漏れると、カレンダーは正しく書けているのに
    // 「同期に失敗しました」というメールが飛ぶ。
    const api = ready({});
    api.MEETINGS.fomc.meetings = [{ date: '2026-09-20', sep: false }];
    const real = api._stubs.PropertiesService.getScriptProperties();
    api._stubs.PropertiesService.getScriptProperties = () => ({
      getProperty: (k) => real.getProperty(k),
      setProperty: (k, v) => {
        if (k === '_lastMaintenanceMail') throw new Error('書けません');
        return real.setProperty(k, v);
      },
      deleteProperty: (k) => real.deleteProperty(k),
    });
    const plan = api.syncCalendar();
    ok(plan && plan.created.length > 0, '同期そのものは成功すること');
  });

  test('確認先の URL が無くても「undefined」と書かない', () => {
    const api = ready({});
    delete api.MEETINGS.fomc.verify_url;
    api.MEETINGS.fomc.meetings = [{ date: '2026-09-20', sep: false }];
    const text = api.maintenanceText_(api.maintenanceReport_(api.syncWindow_()));
    ok(text.indexOf('undefined') === -1, text);
  });

  test('preview の凡例が、実際の表示と合っている', () => {
    const api = ready({});
    const text = api.preview();
    ok(text.indexOf('~ 印') === -1, '使っていない記号を説明しないこと');
    if (text.indexOf('(日付未確定)') !== -1) {
      ok(text.indexOf('「(日付未確定)」は') !== -1, '出ている印を説明すること');
    }
  });

  test('設定が壊れていても showStatus は落ちず、理由を出す', () => {
    // 困ったときに見る画面なので、ここで落ちては元も子もない。
    const api = ready({});
    api.CONFIG.timezone = 'Nowhere/Nothing';
    const text = api.showStatus();
    ok(text.indexOf('timezone') !== -1, text);

    const api2 = ready({});
    api2.CONFIG.filter.minImpact = 'ななじゅう';
    ok(api2.showStatus().indexOf('minImpact') !== -1);
  });

  test('週次まとめは、月曜の午前に何度走らせても1回だけ', () => {
    const posts = [];
    const monday = Date.UTC(2026, 8, 13, 22, 0);   // 9/14(月) 07:00 JST
    const RealDate = Date;
    function FakeDate(...args) {
      if (!(this instanceof FakeDate)) return new RealDate(monday).toString();
      return args.length ? new RealDate(...args) : new RealDate(monday);
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = () => monday;
    FakeDate.UTC = RealDate.UTC;
    FakeDate.parse = RealDate.parse;
    global.Date = FakeDate;
    try {
      const api = ready({
        properties: { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)',
                      WEBHOOK_URL: 'https://example.com/hook' },
        UrlFetchApp: {
          fetch: (url, params) => {
            if (String(url).indexOf('example.com') !== -1) {
              posts.push(String((params && params.payload) || ''));
              return { getResponseCode: () => 200, getContentText: () => 'ok' };
            }
            throw new Error('down');
          },
          fetchAll: (rs) => rs.map(() => ({ getResponseCode: () => 503,
                                            getContentText: () => '' })),
        },
      });
      api.syncCalendar();
      api.syncCalendar();
      api.syncCalendar();
    } finally {
      global.Date = RealDate;
    }
    eq(posts.length, 1, '同じまとめが ' + posts.length + ' 回飛んだ');
  });
});

// ---------------------------------------------------------------------------
// 7周目: 同期のあらゆる地点で失敗させ、カレンダー側を人の手で変えた結果。
// ---------------------------------------------------------------------------
suite('カレンダー側で書き換えられた予定を、正しい姿に戻す', () => {
  function seeded() {
    const calendar = fakeCalendar();
    const store = { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)' };
    const make = () => {
      const api = loadGas({
        Calendar: calendar, properties: store,
        UrlFetchApp: { fetch: () => { throw new Error('down'); },
                       fetchAll: (rs) => rs.map(() => ({ getResponseCode: () => 503,
                                                         getContentText: () => '' })) },
      });
      Object.assign(api.CONFIG.providers, { fred: false, earnings: false, investing: false,
                                            fomcAutoFetch: false, officialTimes: false });
      api.CONFIG.window.daysAhead = 20;
      api.CONFIG.window.daysBack = 5;
      return api;
    };
    make().syncCalendar();
    return { calendar, store, make };
  }

  test('件名を手で直されたら、次の同期で戻す', () => {
    // 前回書いた内容のハッシュだけを見ていると、カレンダー側で書き換わった
    // ことに気づけない。このカレンダーは指標そのものなので、手で直された
    // 件名が残るのは「嘘が残る」のと同じ。
    const { calendar, make } = seeded();
    const id = [...calendar.events.keys()][0];
    const want = calendar.events.get(id).summary;
    calendar.events.get(id).summary = '人が書き換えた件名';

    const plan = make().syncCalendar();
    eq(calendar.events.get(id).summary, want, '元の件名に戻ること');
    ok(plan.updated.length >= 1, '更新として扱うこと');
  });

  test('時刻を手で動かされたら、次の同期で戻す', () => {
    const { calendar, make } = seeded();
    const id = [...calendar.events.keys()].find(
      (k) => calendar.events.get(k).start.dateTime);
    const want = calendar.events.get(id).start.dateTime;
    calendar.events.get(id).start.dateTime = '2026-09-11T03:00:00.000Z';

    make().syncCalendar();
    eq(new Date(calendar.events.get(id).start.dateTime).getTime(),
       new Date(want).getTime(), '元の時刻に戻ること');
  });

  test('Google が別の書き方で返してきても、更新は走らない', () => {
    // Google は送った Z 形式ではなく +09:00 のような書き方で返す。
    // ここを文字列でくらべると、毎回「違う」と判定されて更新が走り続ける。
    const { calendar, make } = seeded();
    calendar.events.forEach((e) => {
      if (!e.start.dateTime) return;
      const shift = (iso) => new Date(new Date(iso).getTime() + 9 * 3600000)
        .toISOString().replace('Z', '+09:00');
      e.start.dateTime = shift(e.start.dateTime);
      e.end.dateTime = shift(e.end.dateTime);
    });
    const plan = make().syncCalendar();
    eq(plan.created.length + plan.updated.length + plan.deleted.length, 0,
       '書き込みが起きないこと');
  });

  test('件名にも時刻にも出ない変化を、取りこぼさない', () => {
    // 予想値が届いた・解説を直した・通知の設定を変えた——どれも件名と開始は
    // 変わらない。内容ハッシュだけが気づける変化なので、ここが効いていないと
    // カレンダーの中身が古いまま残る。
    const { calendar, make } = seeded();
    const id = [...calendar.events.keys()].find(
      (k) => (calendar.events.get(k).extendedProperties.private || {}).indicator === 'us_cpi');
    ok(id, '題材の CPI が入っていること');
    const before = calendar.events.get(id);
    eq(before.description.indexOf('0.3%'), -1, 'まだ予想値は入っていない');

    // 説明文だけが変わる状況を作る（予想値が届いた）
    const api = make();
    const ctx = api.syncWindow_(Y(2026, 9, 11));
    const events = api.collectEvents_(ctx).map((e) => (
      e.indicatorId === 'us_cpi' && api.eventCalendarId_(e, api.CONFIG.timezone) === id
        ? Object.assign({}, e, { forecast: '0.3%' }) : e));
    const existing = api.listManagedEvents_('c', ctx.start, ctx.end);
    const plan = api.buildPlan_('c', events, existing, ctx);
    ok(plan.updated.some((r) => r.resource.id === id),
       '説明文だけの変化も更新として拾うこと');
    const resource = plan.updated.find((r) => r.resource.id === id).resource;
    eq(resource.summary, before.summary, '件名は変わっていないこと');
    eq(resource.start.dateTime, before.start.dateTime, '開始も変わっていないこと');
    ok(resource.description.indexOf('0.3%') !== -1, '説明文には入っていること');
  });

  test('通知の設定を変えたら、既存の予定にも反映する', () => {
    const { calendar, make } = seeded();
    const before = [...calendar.events.values()][0].reminders.overrides.length;
    const api = make();
    api.CONFIG.reminders = { S: [10, 20, 30], A: [10], B: [10], C: [10] };
    const plan = api.syncCalendar();
    ok(plan.updated.length > 0, '通知だけの変化でも更新すること');
    const after = [...calendar.events.values()][0].reminders.overrides.length;
    ok(after !== before || before === 1, before + ' -> ' + after);
  });

  test('このツールが作っていない予定には触らない', () => {
    const { calendar, make } = seeded();
    calendar.events.set('someone-elses', {
      id: 'someone-elses', summary: '他人の予定',
      start: { dateTime: '2026-09-12T01:00:00.000Z' },
      end: { dateTime: '2026-09-12T02:00:00.000Z' },
      extendedProperties: { private: {} },
    });
    make().syncCalendar();
    ok(calendar.events.has('someone-elses'), '消さないこと');
    eq(calendar.events.get('someone-elses').summary, '他人の予定', '書き換えないこと');
  });

  test('目印を外された予定も、管理下に戻す', () => {
    const { calendar, make } = seeded();
    const id = [...calendar.events.keys()][1];
    calendar.events.get(id).extendedProperties.private.ecal = '0';
    make().syncCalendar();
    eq((calendar.events.get(id).extendedProperties.private || {}).ecal, '1');
    // 同じ ID を使い回すので、重複はできない
    const same = [...calendar.events.values()].filter((e) => e.id === id);
    eq(same.length, 1);
  });
});

// ---------------------------------------------------------------------------
suite('どこで失敗しても、次の回で正しい姿に収束する', () => {
  function net() {
    return { fetch: () => { throw new Error('down'); },
             fetchAll: (rs) => rs.map(() => ({ getResponseCode: () => 503,
                                               getContentText: () => '' })) };
  }
  function make(calendar, store) {
    const api = loadGas({ Calendar: calendar, properties: store, UrlFetchApp: net() });
    Object.assign(api.CONFIG.providers, { fred: false, earnings: false, investing: false,
                                          fomcAutoFetch: false, officialTimes: false });
    api.CONFIG.window.daysAhead = 20;
    api.CONFIG.window.daysBack = 5;
    return api;
  }
  const snapshot = (calendar) => [...calendar.events.values()]
    .map((e) => [e.id, e.summary, JSON.stringify(e.start),
                 (e.extendedProperties.private || {}).hash].join('|')).sort().join('\n');

  test('書き込みの途中で落ちても、壊れたまま残らない', () => {
    // 正解の姿を先に作る
    const cleanCal = fakeCalendar();
    const cleanStore = { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)' };
    make(cleanCal, cleanStore).syncCalendar();
    const want = snapshot(cleanCal);

    const ERRORS = ['API call failed with error: Rate Limit Exceeded',
                    'API call failed with error: Forbidden', 'なにか未知の失敗'];
    [1, 3, 7, 15, 25].forEach((failAt) => {
      ERRORS.forEach((text) => {
        const calendar = fakeCalendar();
        let n = 0;
        ['insert', 'update', 'remove'].forEach((name) => {
          const original = calendar.Events[name];
          calendar.Events[name] = function () {
            if (++n === failAt) throw new Error(text);
            return original.apply(this, arguments);
          };
        });
        const store = { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)' };
        try { make(calendar, store).syncCalendar(); } catch (err) { /* 落ちてよい */ }

        // 途中まで書いたものが壊れて残っていないこと
        calendar.events.forEach((item) => {
          const props = (item.extendedProperties || {}).private || {};
          ok(props.ecal === '1', '目印の無い予定が残った: ' + item.id);
          ok(!!props.hash, '内容ハッシュの無い予定が残った: ' + item.id);
          ok(!!item.summary, '件名の無い予定が残った: ' + item.id);
        });

        // 正常に戻したら、落ちなかった場合と同じ姿になること
        const healthy = fakeCalendar({ events: Object.fromEntries(calendar.events) });
        make(healthy, store).syncCalendar();
        const plan = make(healthy, store).syncCalendar();
        eq(plan.created.length + plan.updated.length + plan.deleted.length, 0,
           failAt + '回目で「' + text + '」→ 落ち着かない');
        eq(snapshot(healthy), want, failAt + '回目で「' + text + '」→ 姿が違う');
      });
    });
  });

  test('一覧が読めないときは、何も書き換えない', () => {
    const calendar = fakeCalendar();
    const store = { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)' };
    make(calendar, store).syncCalendar();
    const before = snapshot(calendar);
    calendar.Events.list = () => {
      throw new Error('API call failed with error: Internal error');
    };
    throws(() => make(calendar, store).syncCalendar(), 'Internal error');
    eq(snapshot(calendar), before, '読めないのに書きに行かないこと');
  });
});

// ---------------------------------------------------------------------------
// 6周目: 境界を1つずつ、両側から突いた結果。
// ---------------------------------------------------------------------------
suite('境界: 日程の検査は、必ず理由を返すか null を返す', () => {
  // この関数は「通ったら null / 落としたら理由の文字列」という約束。
  // 途中で素の return を書くと undefined が返り、**検査に通ったことに
  // なってしまう**。壊れた日程が静かに採用される、いちばん危ない形。
  const ok6 = ['2028-01-26', '2028-02-23', '2028-03-22',
               '2028-04-19', '2028-05-17', '2028-06-14'];
  const rows = (dates) => dates.map((d) => ({ date: d, sep: false }));

  test('通る年は null', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    eq(api.validateFomcYear_(rows(ok6), 2028), null);
  });

  test('落とす年は、必ず理由の文字列', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const cases = [
      ['会合数が少ない', ok6.slice(0, 5)],
      ['会合数が多い', ok6.concat(['2028-07-12', '2028-08-09', '2028-09-06',
                                   '2028-10-04', '2028-11-01'])],
      ['読めない日付', ['2028-01-26', 'でたらめ', '2028-03-22',
                        '2028-04-19', '2028-05-17', '2028-06-14']],
      ['空文字の日付', ['2028-01-26', '', '2028-03-22',
                        '2028-04-19', '2028-05-17', '2028-06-14']],
      ['無い日付', ['2028-01-26', '2028-02-30', '2028-03-22',
                    '2028-04-19', '2028-05-17', '2028-06-14']],
      ['別の年', ok6.slice(0, 5).concat(['2029-01-16'])],
      ['重複', ok6.slice(0, 5).concat(['2028-01-26'])],
      ['曜日が外れる', ok6.slice(0, 5).concat(['2028-06-16'])],
      ['間隔が近すぎる', ['2028-01-26', '2028-02-16', '2028-03-08',
                          '2028-03-29', '2028-04-19', '2028-05-10']],
      ['間隔が空きすぎる', ok6.slice(0, 5).concat(['2028-12-13'])],
    ];
    cases.forEach((pair) => {
      const problem = api.validateFomcYear_(rows(pair[1]), 2028);
      eq(typeof problem, 'string', pair[0] + ' を通してしまう: ' + JSON.stringify(problem));
    });
  });

  test('読めない日付が混じった年は、丸ごと採用しない', () => {
    // 「抽出はゆるく、採用は厳しく」の約束が、ここで破れていないこと。
    const api = loadGas({
      Calendar: fakeCalendar(),
      UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => (
        '<div class="panel"><div class="panel-heading">2029 FOMC Meetings</div>'
        + '<div class="fomc-meeting__month"><strong>January</strong></div>'
        + '<div class="fomc-meeting__date">30-31</div>'
        + '<div class="fomc-meeting__month"><strong>February</strong></div>'
        + '<div class="fomc-meeting__date">99-99</div></div>') }) },
    });
    const meetings = api.allMeetings_('fomc');
    ok(meetings.every((m) => m.date.slice(0, 4) !== '2029'),
       '検査に落ちた年を採らないこと: ' + meetings.map((m) => m.date).join(','));
  });
});

// ---------------------------------------------------------------------------
suite('境界: 同期範囲の端', () => {
  const TZS = ['Asia/Tokyo', 'America/New_York', 'UTC', 'Australia/Sydney',
               'America/Los_Angeles'];

  test('端の日は入り、1日外は入らない（どの時差でも・1日のどの時刻でも）', () => {
    TZS.forEach((tz) => {
      const api = loadGas({ Calendar: fakeCalendar() });
      api.CONFIG.timezone = tz;
      const ctx = { start: Y(2026, 9, 10), end: Y(2026, 9, 20), timezone: tz };
      [[Y(2026, 9, 9), false], [Y(2026, 9, 10), true], [Y(2026, 9, 20), true],
       [Y(2026, 9, 21), false]].forEach((row) => {
        ['00:00', '12:00', '23:59'].forEach((t) => {
          const instant = api.zonedTime_(row[0], t, tz);
          eq(api.inDisplayWindow_(instant, ctx), row[1],
             tz + ' ' + K(row[0]) + ' ' + t);
        });
      });
    });
  });

  test('生成の判定と、整理してよい範囲の判定がそろっている', () => {
    // ここがずれると、作った直後の予定を次の回で消してしまう。
    TZS.forEach((tz) => {
      const api = loadGas({ Calendar: fakeCalendar() });
      api.CONFIG.timezone = tz;
      const ctx = { start: Y(2026, 9, 10), end: Y(2026, 9, 20), timezone: tz };
      [Y(2026, 9, 9), Y(2026, 9, 10), Y(2026, 9, 20), Y(2026, 9, 21)].forEach((day) => {
        ['00:00', '23:59'].forEach((t) => {
          const instant = api.zonedTime_(day, t, tz);
          const resource = api.toCalendarResource_(event(api, {
            start: instant, end: new Date(instant.getTime() + 1800000) }));
          eq(api.inPruneRange_({ id: resource.id, start: resource.start,
                                 end: resource.end,
                                 extendedProperties: resource.extendedProperties }, ctx),
             api.inDisplayWindow_(instant, ctx), tz + ' ' + K(day) + ' ' + t);
        });
      });
    });
  });

  test('幅0の窓でも動く', () => {
    const api = loadGas({ Calendar: fakeCalendar(),
                          properties: { _calendarId: 'c', _calendarName: 'x' } });
    Object.assign(api.CONFIG.providers, { fred: false, earnings: false, investing: false,
                                          fomcAutoFetch: false, officialTimes: false });
    api.CONFIG.window.daysAhead = 0;
    api.CONFIG.window.daysBack = 0;
    const ctx = api.syncWindow_(Y(2026, 9, 10));
    eq([K(ctx.start), K(ctx.end)], ['2026-09-10', '2026-09-10']);
    api.collectEvents_(ctx).forEach((e) => {
      eq(K(api.localDate_(e.start, 'Asia/Tokyo')), '2026-09-10');
    });
  });
});

// ---------------------------------------------------------------------------
suite('境界: 閏日・月末・階層の境目', () => {
  test('2月の規則は、その月に無い日に置かれない', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    [2024, 2025, 2026, 2028, 2032].forEach((y) => {
      [28, 29, 30, 31].forEach((day) => {
        const dates = api.ruleDates_({ type: 'day_of_month', day: day },
                                     Y(y, 2, 1), Y(y, 2, 29)).map(K);
        eq(dates.length, 1, y + '/' + day);
        ok(/^\d{4}-02-\d{2}$/.test(dates[0]), y + '/' + day + ' -> ' + dates[0]);
        ok(Number(dates[0].slice(8)) <= 29, dates[0]);
      });
    });
  });

  test('月内の営業日への寄せは、必ずその月に収まる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    for (let y = 2024; y <= 2035; y++) {
      for (let m = 1; m <= 12; m++) {
        [1, 15, 27, 28].forEach((d) => {
          const near = api.businessDayNearDay_(y, m, d);
          eq(near.getUTCMonth() + 1, m, y + '-' + m + ' ' + d + '日ごろ -> ' + K(near));
          ok(api.isBusinessDay_(near), K(near) + ' が営業日でない');
        });
        const days = api.businessDaysInMonth_(y, m);
        ok(days.length > 0, y + '-' + m + ' に営業日が無い');
      }
    }
  });

  test('階層の境目', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    [[100, 'S'], [90, 'S'], [89, 'A'], [75, 'A'], [74, 'B'],
     [55, 'B'], [54, 'C'], [0, 'C']].forEach((row) => {
      eq(api.tierFor_(row[0]), row[1], String(row[0]));
    });
  });

  test('しきい値ちょうどは入り、1つ下は入らない', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    api.CONFIG.filter.minImpact = 60;
    const at = (impact) => api.applyFilter_(
      [{ indicatorId: 'x', impact: impact, country: 'US', category: 'c' }]).length;
    eq(at(60), 1);
    eq(at(59), 0);
  });

  test('推定日の間引きは、しきい値ちょうどまで効く', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const win = api.SUPERSEDE_WINDOW_DAYS;
    const at = (gap) => {
      const day = api.addDays_(Y(2026, 9, 11), gap);
      return api.dropSupersededEstimates_([
        event(api, { confidence: 'official',
                     start: api.zonedTime_(Y(2026, 9, 11), '08:30', 'America/New_York') }),
        event(api, { confidence: 'estimated',
                     start: api.zonedTime_(day, '08:30', 'America/New_York') }),
      ], 'Asia/Tokyo').length;
    };
    eq(at(win - 1), 1, (win - 1) + '日差');
    eq(at(win), 1, win + '日差（ちょうど）');
    eq(at(win + 1), 2, (win + 1) + '日差');
  });
});

// ---------------------------------------------------------------------------
// 5周目: 同じ計算を Python で独立に書き直し、66,983 件を突き合わせた結果。
// ---------------------------------------------------------------------------
suite('元日が土曜の年、前年12月31日は連邦休日', () => {
  // 元日が土曜だと、前日の金曜（前年12月31日）が振替休日になる。
  // これを翌年の表に入れたままだと 12/31 を営業日と数えてしまい、
  // 「その月の最終営業日」に置く指標が1日ずれていた。
  const YEARS = [2021, 2027, 2032];   // 翌年の元日が土曜

  test('その年の表に入っている', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    YEARS.forEach((y) => {
      ok(api.federalHolidays_(y)[y + '-12-31'], y + '-12-31 が休日として無い');
      ok(!api.isBusinessDay_(api.ymd_(y, 12, 31)), y + '-12-31 を営業日にしている');
    });
  });

  test('翌年の表からは外れている', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    YEARS.forEach((y) => {
      const table = api.federalHolidays_(y + 1);
      ok(!table[y + '-12-31'], '翌年の表に前年の日付を残さない');
      ok(!table[(y + 1) + '-01-01'], '元日そのものは休みにならない（土曜なので）');
    });
  });

  test('12月の最終営業日が1日手前になる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    YEARS.forEach((y) => {
      const days = api.businessDaysInMonth_(y, 12);
      eq(K(days[days.length - 1]), y + '-12-30', y + '年12月');
    });
  });

  test('市場は開いている（年内最終取引日は休場にしない）', () => {
    // NYSE の規則: 休日が土曜なら前日の金曜を休場にするが、その金曜が
    // 年内最後の取引日になるときは休場にしない。2021-12-31 は実際に
    // 取引されている。連邦休日とは扱いが違う。
    const api = loadGas({ Calendar: fakeCalendar() });
    YEARS.forEach((y) => {
      ok(!api.marketHolidays_(y)[y + '-12-31'], y + '-12-31 を休場にしてはいけない');
      ok(!api.marketHolidays_(y + 1)[y + '-12-31'], '翌年の表にも入れない');
    });
  });

  test('ふつうの年は、元日がその年の休みになる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    eq(Object.keys(api.federalHolidays_(2026)).sort(), [
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19',
      '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26',
      '2026-12-25',
    ], '2026年（独立記念日が土曜なので 7/3 に振替）');
  });
});

// ---------------------------------------------------------------------------
// 4周目: 壊れた・極端な・敵意のある入力。
// 「取得先がいつも行儀よく答える」という前提を全部外して突いた結果。
// ---------------------------------------------------------------------------
suite('型の名前に、オブジェクトの持ち物を通さない', () => {
  const POISON = ['__proto__', 'constructor', 'toString', 'hasOwnProperty',
                  'valueOf', '__defineGetter__'];

  test('根拠として認めるのは4種類だけ', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    POISON.forEach((name) => {
      // CONFIDENCE_RANK[name] をそのまま見ると Object の中身が返り、
      // 「日付の根拠 toString」という予定ができてしまっていた。
      eq(api.confidenceRank_(name), 0, name);
      eq(event(api, { confidence: name }).confidence, 'estimated', name);
    });
  });

  test('時刻の根拠として認めるのは3種類だけ', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    POISON.forEach((name) => {
      eq(api.timeRank_(name), 0, name);
      eq(event(api, { timeSource: name }).timeSource, 'fallback', name);
    });
  });

  test('カレンダーに保存された値が書き換えられていても、型は守る', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    POISON.concat(['', 'OFFICIAL', 'まったく別の値']).forEach((name) => {
      const back = api.eventFromResource_({
        id: 'ec' + 'a'.repeat(30), summary: 'x',
        start: { dateTime: '2026-09-11T12:30:00.000Z' },
        end: { dateTime: '2026-09-11T13:00:00.000Z' },
        extendedProperties: { private: { ecal: '1', indicator: 'us_cpi', impact: '98',
                                         confidence: name, ts: name } },
      });
      ok(['official', 'reported', 'rule', 'estimated'].indexOf(back.confidence) >= 0,
         name + ' -> ' + back.confidence);
      ok(['official', 'reported', 'fallback'].indexOf(back.timeSource) >= 0,
         name + ' -> ' + back.timeSource);
    });
  });
});

// ---------------------------------------------------------------------------
suite('長すぎる中身で、同期そのものを失敗させない', () => {
  test('取得先が飲み込んだ長文が、そのまま件名に入らない', () => {
    // 「値」の欄がページの残り全部を飲み込むと、9000 文字の件名になって
    // Google に弾かれ、**その回の同期が丸ごと失敗**していた。
    const api = loadGas({ Calendar: fakeCalendar() });
    const huge = event(api, { indicatorId: 'us_cpi', actual: 'x'.repeat(9000),
                              forecast: 'y'.repeat(9000), note: 'z'.repeat(9000) });
    ok(huge.actual.length <= 40, '入口で切ること: ' + huge.actual.length);
    ok(huge.note.length <= 3000, huge.note.length);

    const resource = api.toCalendarResource_(huge);
    ok(resource.summary.length <= 1024, '件名: ' + resource.summary.length);
    ok(resource.description.length <= 8192, '説明: ' + resource.description.length);
  });

  test('入口の制限を通らずに来たものも、最後に必ず切る', () => {
    // makeEvent_ を通らない経路がこの先できても、Google に弾かれる長さの
    // ものを投げないための最後の防波堤。
    const api = loadGas({ Calendar: fakeCalendar() });
    const raw = {
      indicatorId: 'us_cpi', title: 'T'.repeat(4000), impact: 98,
      country: 'US', category: '物価', source: 'fred',
      confidence: 'official', timeSource: 'fallback', exactTime: false,
      allDay: false, period: null, actual: 'A'.repeat(4000), forecast: null,
      previous: null, note: 'N'.repeat(20000), url: null, extra: {},
      start: new Date(Date.UTC(2026, 8, 11, 12, 30)),
      end: new Date(Date.UTC(2026, 8, 11, 13, 0)),
    };
    const resource = api.toCalendarResource_(raw);
    ok(resource.summary.length <= 1024, '件名: ' + resource.summary.length);
    ok(resource.description.length <= 8192, '説明: ' + resource.description.length);
    ok(resource.summary.indexOf('…') !== -1, '切ったと分かる印が付くこと');
  });

  test('保存済みの予定が長大でも、組み立て直せる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const back = api.eventFromResource_({
      id: 'ec' + 'a'.repeat(30), summary: 's'.repeat(9000),
      start: { dateTime: '2026-09-11T12:30:00.000Z' },
      end: { dateTime: '2026-09-11T13:00:00.000Z' },
      extendedProperties: { private: { ecal: '1', indicator: 'なにか未知の指標',
                                       impact: '98', a: 'x'.repeat(9000) } },
    });
    const resource = api.toCalendarResource_(back);
    ok(resource.summary.length <= 1024, resource.summary.length);
    ok(resource.description.length <= 8192, resource.description.length);
  });
});

// ---------------------------------------------------------------------------
suite('読めない日付を、そのまま先へ流さない', () => {
  test('日付として読めないものは null で返す', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    ['', 'x', '0000-00-00', '9999-99-99', '2026-02-30', '2026-13-01',
     '2026/09/11', '20260911', null, undefined].forEach((text) => {
      eq(api.parseDateKey_(text), null, JSON.stringify(text));
    });
    eq(K(api.parseDateKey_('2026-09-11')), '2026-09-11');
    eq(K(api.parseDateKey_('2026-09-11T12:00:00Z')), '2026-09-11', '時刻付きも読める');
    eq(K(api.parseDateKey_('2026-2-3')), '2026-02-03', '0 詰めでなくても読める');
  });

  test('読めない日時で予定を作ろうとしたら、はっきり止まる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    throws(() => api.makeEvent_({ indicatorId: 'us_cpi', title: 'x', impact: 50,
                                  start: new Date('でたらめ'), end: new Date() }),
           '妥当な Date');
  });

  test('FRED が壊れた日付を返しても、その行だけ飛ばす', () => {
    const body = JSON.stringify({ release_dates: [
      { release_name: 'Consumer Price Index', date: 'でたらめ' },
      { release_name: 'Consumer Price Index', date: '9999-99-99' },
      { release_name: 'Producer Price Index', date: '2026-09-16' },
    ] });
    const api = loadGas({
      Calendar: fakeCalendar(), properties: { FRED_API_KEY: 'k' },
      UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200,
                                     getContentText: () => body }) },
    });
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };
    const events = api.providerFred_(ctx);
    eq(events.map((e) => e.indicatorId), ['us_ppi'], '読めた行だけ残ること');
  });

  test('FRED の応答が配列でなくても落ちない', () => {
    ['{"release_dates":"x"}', '{"release_dates":123}', 'null', '[]', '0'].forEach((body) => {
      const api = loadGas({
        Calendar: fakeCalendar(), properties: { FRED_API_KEY: 'k' },
        UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200,
                                       getContentText: () => body }) },
      });
      const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };
      eq(api.providerFred_(ctx), [], body);
    });
  });

  test('手入力の会合日程が壊れていても、そこだけ飛ばす', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    api.CONFIG.providers.fomcAutoFetch = false;
    api.MEETINGS.fomc.meetings.push({ date: 'でたらめ', sep: false });
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };
    const events = api.providerFomc_(ctx);   // 例外が出なければ合格
    ok(events.some((e) => e.indicatorId === 'us_fomc_rate'), '他の会合は出ること');
    api.MEETINGS.fomc.meetings.pop();
  });
});

// ---------------------------------------------------------------------------
suite('桁違いに大きい応答で、実行時間を食いつぶさない', () => {
  test('予定表の行が多すぎたら打ち切る', () => {
    const rows = [];
    for (let i = 0; i < 20000; i++) {
      rows.push('<tr><td>2026-09-' + String((i % 28) + 1).padStart(2, '0') + '</td>'
        + '<td>Consumer Price Index for August 2026</td><td>08:30 AM</td></tr>');
    }
    const api = loadGas({ Calendar: fakeCalendar() });
    const parsed = api.parseScheduleRows_('<table>' + rows.join('') + '</table>', 2026);
    ok(parsed.length <= 1000, '打ち切ること: ' + parsed.length);
    ok(parsed.length >= 3, '途中までは読めていること');
  });

  test('本物の年間予定表の大きさは、打ち切りに掛からない', () => {
    // 年間の予定表はどの機関でも 300 行に届かない。
    const rows = [];
    for (let i = 0; i < 260; i++) {
      rows.push('<tr><td>2026-09-' + String((i % 28) + 1).padStart(2, '0') + '</td>'
        + '<td>Consumer Price Index for August 2026</td><td>08:30 AM</td></tr>');
    }
    const api = loadGas({ Calendar: fakeCalendar() });
    eq(api.parseScheduleRows_('<table>' + rows.join('') + '</table>', 2026).length, 260);
  });
});

// ---------------------------------------------------------------------------
suite('発表予定表（発表時刻の一次情報）', () => {
  // 機関ごとに列の並びも日付の書式も違う。class や id には頼らない。
  const BLS = '<table><tr><th>Release Date</th><th>Release</th><th>Time</th></tr>'
    + '<tr><td>Tuesday, September 15, 2026</td>'
    + '<td><a href="/x">Consumer Price Index for August 2026</a></td>'
    + '<td>08:30 AM</td></tr>'
    + '<tr><td>Friday, September 4, 2026</td>'
    + '<td>Employment Situation for August 2026</td><td>8:30 a.m.</td></tr>'
    + '<tr><td>Sep. 16</td><td>Producer Price Index for August 2026</td>'
    + '<td>08:30 AM</td></tr></table>';
  const BEA = '<table><tbody>'
    + '<tr><td>8:30 AM EDT</td><td>September 25, 2026</td>'
    + '<td>Gross Domestic Product, 2nd Quarter 2026</td></tr>'
    + '<tr><td>8:30 AM EDT</td><td>September 28, 2026</td>'
    + '<td>Personal Income and Outlays, August 2026</td></tr>'
    + '<tr><td>8:30 AM EDT</td><td>September 3, 2026</td>'
    + '<td>U.S. International Trade in Goods and Services, July 2026</td></tr>'
    + '</tbody></table>';
  const CENSUS = '<table>'
    + '<tr><td>09/16/2026</td><td>10:00 AM</td>'
    + '<td>Advance Monthly Sales for Retail and Food Services, August 2026</td></tr>'
    + '<tr><td>09/17/2026</td><td>8:30 AM</td>'
    + '<td>New Residential Construction, August 2026</td></tr>'
    + '<tr><td>09/24/2026</td><td>10:00 AM</td>'
    + '<td>New Residential Sales, August 2026</td></tr></table>';

  function serving(pages, capture) {
    return loadGas({
      Calendar: fakeCalendar(),
      UrlFetchApp: {
        fetch: (url) => {
          if (capture) capture.push(url);
          const key = Object.keys(pages).find((k) => url.indexOf(k) !== -1);
          if (!key) throw new Error('down: ' + url);
          return { getResponseCode: () => 200, getContentText: () => pages[key] };
        },
      },
    });
  }
  const ALL = { 'bls.gov': BLS, 'bea.gov': BEA, 'census.gov': CENSUS };
  const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };

  test('三つの機関の、違う書式の表をどれも読める', () => {
    const api = serving(ALL);
    const events = api.providerOfficial_(ctx);
    const got = {};
    events.forEach((e) => {
      got[e.indicatorId] = K(api.localDate_(e.start, 'America/New_York'))
        + ' ' + api.formatClock_(e.start, 'America/New_York').time;
    });
    eq(got.us_cpi, '2026-09-15 08:30', 'BLS: 曜日つきの日付');
    eq(got.us_nfp, '2026-09-04 08:30', 'BLS: 小文字の a.m.');
    eq(got.us_ppi, '2026-09-16 08:30', 'BLS: 年が書かれていない行');
    eq(got.us_gdp, '2026-09-25 08:30', 'BEA: 列の順が違う');
    eq(got.us_pce, '2026-09-28 08:30', 'BEA');
    eq(got.us_trade_balance, '2026-09-03 08:30', 'BEA');
    eq(got.us_retail_sales, '2026-09-16 10:00', 'Census: スラッシュ日付・10時');
    eq(got.us_housing_starts, '2026-09-17 08:30', 'Census');
    eq(got.us_new_home_sales, '2026-09-24 10:00', 'Census');
  });

  test('日付も時刻も、一次情報として扱う', () => {
    const api = serving(ALL);
    const cpi = api.providerOfficial_(ctx).find((e) => e.indicatorId === 'us_cpi');
    eq(cpi.confidence, 'official', '日付の根拠');
    eq(cpi.timeSource, 'official', '時刻の根拠');
    eq(cpi.source, 'official');
    ok(cpi.exactTime, 'カタログの値を当てたのではないこと');
  });

  test('カタログの暫定値より、予定表の時刻が勝つ', () => {
    // カタログは 8:30 ET と書いてあるが、予定表が 09:15 と言うなら従う。
    const shifted = BLS.replace('<td>08:30 AM</td></tr>'
      + '<tr><td>Friday, September 4, 2026</td>', '<td>09:15 AM</td></tr>'
      + '<tr><td>Friday, September 4, 2026</td>');
    const api = serving({ 'bls.gov': shifted, 'bea.gov': BEA, 'census.gov': CENSUS });
    Object.assign(api.CONFIG.providers, { fred: false, earnings: false,
                                          investing: false, fomcAutoFetch: false });
    const events = api.collectEvents_(ctx);
    const cpi = events.find((e) => e.indicatorId === 'us_cpi');
    eq(api.formatClock_(cpi.start, 'America/New_York').time, '09:15');
    eq(cpi.timeSource, 'official');
    ok(api.renderDescription_(cpi).indexOf('暫定値') === -1, '暫定だとは言わないこと');
  });

  test('読み取れなければ丸ごと捨て、暫定値に落ちる', () => {
    // 表の作りが変わって数行しか取れない、という状況。中途半端に採らない。
    const broken = '<table><tr><td>Sep. 15, 2026</td><td>Consumer Price Index</td>'
      + '<td>08:30 AM</td></tr></table>';
    const api = serving({ 'bls.gov': broken, 'bea.gov': broken, 'census.gov': broken });
    eq(api.providerOfficial_(ctx), [], '1行しか取れないページは採用しない');
    ok(api.sourceIsDown_('official'), '落ちている扱いにすること');
  });

  test('取得できなくても同期は続き、時刻は暫定値だと明記される', () => {
    const api = serving({});   // どの URL も落ちている
    Object.assign(api.CONFIG.providers, { fred: false, earnings: false,
                                          investing: false, fomcAutoFetch: false });
    const cpi = api.collectEvents_(ctx).find((e) => e.indicatorId === 'us_cpi');
    ok(cpi, '予定そのものは出ること');
    eq(cpi.timeSource, 'fallback');
    ok(api.renderDescription_(cpi).indexOf('未確認の暫定値') !== -1,
       '確かめていないと、はっきり書くこと');
  });

  test('ありえない時刻や日付は読み間違いとみなす', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    eq(api.parseScheduleTime_('02:30 AM'), null, '真夜中の発表はない');
    eq(api.parseScheduleTime_('11:45 PM'), null);
    eq(api.parseScheduleTime_('08:75 AM'), null, '分が壊れている');
    eq(api.parseScheduleTime_('08:30 AM'), '08:30');
    eq(api.parseScheduleTime_('12:00 PM'), '12:00', '正午');
    eq(api.parseScheduleTime_('14:00'), '14:00', '24時間表記');

    eq(api.parseScheduleDate_('September 31, 2026', 2026), null, '存在しない日');
    eq(api.parseScheduleDate_('September 15, 2031', 2026), null, '表の年から離れすぎ');
    eq(K(api.parseScheduleDate_('September 15, 2026', 2026)), '2026-09-15');
    eq(K(api.parseScheduleDate_('Sep. 15', 2026)), '2026-09-15', '年は表から補う');
  });

  test('日付は、欄の先頭にあるものだけを読む', () => {
    // 名前の欄を日付の欄と取り違えると、まったく別の日に予定が入る。
    // 「先頭にある日付だけ」という約束で、それを防いでいる。
    const api = loadGas({ Calendar: fakeCalendar() });
    eq(api.parseScheduleDate_('Release for Sep. 15 data', 2026), null,
       '途中の「Sep. 15」は日付として読まない');
    eq(api.parseScheduleDate_('Revision of 2026-09-15 figures', 2026), null,
       '途中の「2026-09-15」も読まない');
    eq(api.parseScheduleDate_('Schedule 09/15/2026 update', 2026), null,
       '途中の「09/15/2026」も読まない');
    eq(api.parseScheduleDate_('Consumer Price Index for May 2026', 2026), null);
    eq(api.parseScheduleDate_('Employment Situation', 2026), null);

    // 先頭にあれば読む。曜日が前に付く表もあるので、それだけは落とす。
    eq(K(api.parseScheduleDate_('Sep. 15, 2026', 2026)), '2026-09-15');
    eq(K(api.parseScheduleDate_('2026-09-15', 2026)), '2026-09-15');
    eq(K(api.parseScheduleDate_('09/15/2026', 2026)), '2026-09-15');
    eq(K(api.parseScheduleDate_('Tuesday, September 15, 2026', 2026)), '2026-09-15');
  });

  test('名前の欄を日付の欄と取り違えない', () => {
    const api = serving({ 'bls.gov':
      '<table>'
      + '<tr><td>September 15, 2026</td><td>Consumer Price Index, Sep. 22 revision</td>'
      + '<td>08:30 AM</td></tr>'
      + '<tr><td>September 4, 2026</td><td>Employment Situation for August 2026</td>'
      + '<td>08:30 AM</td></tr>'
      + '<tr><td>September 16, 2026</td><td>Producer Price Index for August 2026</td>'
      + '<td>08:30 AM</td></tr></table>' });
    const cpi = api.providerOfficial_(ctx).find((e) => e.indicatorId === 'us_cpi');
    eq(K(api.localDate_(cpi.start, 'America/New_York')), '2026-09-15',
       '名前の中の 9/22 ではなく、日付欄の 9/15 を採ること');
  });

  test('対応づけられない発表は、黙って飛ばす', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    ['Union Members 2025', 'County Employment and Wages for June 2026',
     'Real Earnings for August 2026'].forEach((name) => {
      eq(api.matchScheduleRelease_(name), null, name);
    });
  });

  test('checkOfficialTimes が、読めているかをそのまま見せる', () => {
    const api = serving(ALL);
    const text = api.checkOfficialTimes();
    ok(text.indexOf('✅') !== -1, text);
    ok(text.indexOf('米 消費者物価指数 (CPI)') !== -1, text);

    const dead = serving({});
    const bad = dead.checkOfficialTimes();
    ok(bad.indexOf('❌') !== -1, bad);
    ok(bad.indexOf('officialSchedules') !== -1, 'どこを直せばよいか書いてあること');
  });
});

// ---------------------------------------------------------------------------
suite('週次まとめの見え方', () => {
  function digestOf(api) {
    Object.assign(api.CONFIG.providers,
      { fred: false, earnings: false, investing: false, fomcAutoFetch: false });
    const ctx = api.syncWindow_(Y(2026, 9, 11));
    const all = api.weeklyDigestEvents_(api.collectEvents_(ctx), ctx);
    // 最重要が入る週（9/14 の週）を選ぶ
    return all.find((e) => e.title.indexOf('最重要') !== -1) || all[0];
  }

  test('まとめ自体は「予定日未確定」にならない', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const digest = digestOf(api);
    // 月曜そのものなので、日付に迷う余地がない。
    eq(digest.confidence, 'rule');
    ok(api.renderTitle_(digest).indexOf('予定日未確定') === -1,
       api.renderTitle_(digest));
  });

  test('まとめの本文に、影響度や根拠の行を出さない', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const text = api.renderDescription_(digestOf(api));
    ok(text.indexOf('影響度') === -1, text);
    ok(text.indexOf('日付の根拠') === -1, text);
    ok(text.indexOf('⚠️') === -1, '推定の断り書きも出さない');
    ok(text.indexOf('今週の山場') !== -1, '中身は残っていること');
    ok(text.indexOf('自動同期') !== -1, '目印は付いていること');
  });

  test('一覧の未確定の印が、指標名の一部に見えない', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const line = api.renderLine_(
      event(api, { indicatorId: 'us_cpi', confidence: 'estimated' }));
    ok(line.indexOf('(日付未確定)') !== -1, line);
    ok(line.indexOf('~') === -1, '「~」は使わない: ' + line);

    const sure = api.renderLine_(
      event(api, { indicatorId: 'us_cpi', confidence: 'official' }));
    ok(sure.indexOf('未確定') === -1, sure);
  });
});

// ---------------------------------------------------------------------------
suite('未確定の断り書きは、未確定の中身に合わせる', () => {
  const api = loadGas({ Calendar: fakeCalendar() });

  test('発表規則から推定した日付は「推定」と書く', () => {
    const cpi = event(api, { indicatorId: 'us_cpi', confidence: 'estimated' });
    const text = api.renderDescription_(cpi);
    ok(text.indexOf('過去の慣例から推定') !== -1, text);
  });

  test('会合日程は「推定」ではなく「未照合」と書く', () => {
    // FOMC の日付は Fed が公表したものの写しで、推定ではない。
    // 同じ文言を出すと嘘になる。
    const fomc = event(api, { indicatorId: 'us_fomc_rate', impact: 100,
                              confidence: 'estimated' });
    const text = api.renderDescription_(fomc);
    ok(text.indexOf('照合できていません') !== -1, text);
    ok(text.indexOf('過去の慣例から推定') === -1, '推定だとは言わないこと');
  });

  test('根拠がはっきりしていれば、断り書きは出ない', () => {
    ['official', 'reported', 'rule'].forEach((confidence) => {
      const text = api.renderDescription_(
        event(api, { indicatorId: 'us_cpi', confidence: confidence }));
      ok(text.indexOf('⚠️') === -1, confidence + ': ' + text);
    });
  });

  test('文言は、どの情報源が勝ったかで変わらない', () => {
    // 情報源が入れ替わるたびに説明文が変わると、中身は同じなのに
    // 更新が走り続ける。
    const fromRules = api.renderDescription_(
      event(api, { indicatorId: 'us_cpi', confidence: 'estimated', source: 'rules' }));
    const fromSite = api.renderDescription_(
      event(api, { indicatorId: 'us_cpi', confidence: 'estimated', source: 'investing' }));
    eq(fromRules, fromSite);
  });
});

// ---------------------------------------------------------------------------
suite('発表名の名寄せ（取り違えると他国・他指標の数値が入る）', () => {
  const api = loadGas({ Calendar: fakeCalendar() });
  const day = Y(2026, 9, 11);

  test('他の国の同名指標に当てない', () => {
    // ユーロ圏の CPI が米 CPI の欄に入ると、カレンダーの数字が丸ごと嘘になる。
    eq(api.matchEventName_('Core CPI (MoM)', day, 'US').id, 'us_cpi');
    eq(api.matchEventName_('Core CPI (MoM)', day, 'EU'), null);
    eq(api.matchEventName_('S&P Global Eurozone Manufacturing PMI', day, 'EU'), null);
    eq(api.matchEventName_('Chinese Manufacturing PMI', day, 'CN').id, 'cn_pmi');
    eq(api.matchEventName_('BoJ Interest Rate Decision', day, 'JP').id, 'jp_boj_decision');
    eq(api.matchEventName_('ECB Interest Rate Decision', day, 'EU').id, 'eu_ecb_decision');
  });

  test('国が分からなくても、具体的な方を採る', () => {
    // 「ism manufacturing pmi」は「manufacturing pmi」より具体的。
    eq(api.matchEventName_('ISM Manufacturing PMI', day).id, 'us_ism_mfg');
    eq(api.matchEventName_('Chinese Manufacturing PMI', day).id, 'cn_pmi');
    eq(api.matchEventName_('ISM Non-Manufacturing PMI', day).id, 'us_ism_services');
  });

  test('名前が同じものは、発表日で見分ける', () => {
    eq(api.matchEventName_('Michigan Consumer Sentiment', Y(2026, 9, 11), 'US').id,
       'us_umich_prelim', '第2金曜は速報値');
    eq(api.matchEventName_('Michigan Consumer Sentiment', Y(2026, 9, 25), 'US').id,
       'us_umich_final', '最終金曜は確報値');
  });

  test('同じ発表に含まれる項目は、その発表に寄せる', () => {
    // 雇用統計は失業率も平均時給も同じ 8:30 の発表。別々の予定にしない。
    ['Nonfarm Payrolls', 'Unemployment Rate', 'Average Hourly Earnings (MoM)']
      .forEach((name) => eq(api.matchEventName_(name, day, 'US').id, 'us_nfp', name));
    ['Housing Starts', 'Building Permits']
      .forEach((name) => eq(api.matchEventName_(name, day, 'US').id,
                            'us_housing_starts', name));
    ['Core PCE Price Index (MoM)', 'Personal Spending (MoM)']
      .forEach((name) => eq(api.matchEventName_(name, day, 'US').id, 'us_pce', name));
  });

  test('緩いパターンより、具体的なパターンを優先する', () => {
    // カタログに緩いパターンを足してしまっても、より具体的な方が勝つこと。
    const loose = loadGas({ Calendar: fakeCalendar() });
    loose.INDICATORS.push({ id: 'x_loose', name: 'ざっくり PMI', country: 'US',
                            category: 'survey', impact: 60, time: '10:00',
                            // 発表日はわざとこの題材の日そのものにする。
                            // 「日付の近さ」だけで決めると、こちらが勝ってしまう。
                            schedule: { type: 'day_of_month', day: 11 },
                            match: ['pmi'] });
    // 名寄せの索引は初回参照時に作られるので、この読み込みではまだ空。
    // 足した指標もそのまま索引に入る。
    const hit = loose.matchEventName_('ISM Manufacturing PMI', day, 'US');
    eq(hit.id, 'us_ism_mfg',
       '名前で決着がつくなら、日付の近さより名前の具体性を優先すること');
    eq(loose.matchEventName_('Some Other PMI', day, 'US').id, 'x_loose',
       '具体的なパターンが当たらなければ、緩い方に落ちる');
    loose.INDICATORS.pop();
  });

  test('カタログに無いものには当てない', () => {
    ['3-Year Note Auction', 'Fed Monetary Policy Report', 'ISM Manufacturing Prices',
     'Chinese Non-Manufacturing PMI', 'まったく関係のない行']
      .forEach((name) => eq(api.matchEventName_(name, day, 'US'), null, name));
  });

  test('通貨の欄から国を読む', () => {
    const cell = '<td class="left flagCur noWrap">'
      + '<span title="United States" class="ceFlags United_States">&nbsp;</span>USD</td>';
    eq(api.investingCountry_(cell), 'US');
    eq(api.investingCountry_('<td class="flagCur">CNY</td>'), 'CN');
    eq(api.investingCountry_('<td class="flagCur">EUR</td>'), 'EU');
    eq(api.investingCountry_('<td class="flagCur">CHF</td>'), null, '知らない通貨は当てない');
    eq(api.investingCountry_('<td class="left event">CPI</td>'), null,
       '欄が無ければ null（名前だけの名寄せに戻る）');
  });

  test('取得した行の国が、名寄せに効いている', () => {
    const rows = api.parseInvestingRows_(
      '<tr data-event-datetime="2026/09/11 09:00:00">'
      + '<td class="left flagCur noWrap">CNY</td>'
      + '<td class="left event">Chinese Manufacturing PMI</td>'
      + '<td id="eventActual_1">49.5</td></tr>');
    eq(rows.length, 1);
    eq(rows[0].country, 'CN');
    eq(api.matchEventName_(rows[0].name, day, rows[0].country).id, 'cn_pmi',
       '中国の数値が米指標の欄に入らないこと');
  });
});

// ---------------------------------------------------------------------------
suite('同じ発表をひとつにまとめる基準', () => {
  test('時刻つきの予定は、指標の地元の日付でまとめる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    api.CONFIG.timezone = 'Australia/Sydney';
    // どちらも米東部 1/11 の CPI。集計サイトが 7:45 ET、FRED＋カタログが
    // 8:30 ET と言う。シドニー（この時期は UTC+11）だと 1/11 と 1/12 に割れる。
    const site = event(api, { indicatorId: 'us_cpi', confidence: 'reported',
      exactTime: true, start: new Date(Date.UTC(2027, 0, 11, 12, 45)) });
    const fred = event(api, { indicatorId: 'us_cpi', confidence: 'official',
      start: new Date(Date.UTC(2027, 0, 11, 13, 30)) });
    eq(K(api.localDate_(site.start, 'Australia/Sydney')), '2027-01-11');
    eq(K(api.localDate_(fred.start, 'Australia/Sydney')), '2027-01-12',
       '表示日は割れていること（この題材の前提）');
    eq(api.releaseKey_(site, 'Australia/Sydney'), api.releaseKey_(fred, 'Australia/Sydney'),
       '地元の日付では同じ発表');

    const merged = api.mergeEvents_([site, fred], 'Australia/Sydney');
    eq(merged.length, 1, 'カレンダーに2つ並ばないこと');
    eq(merged[0].confidence, 'official');
    eq(merged[0].exactTime, true, '実測時刻は残ること');
  });

  test('終日の予定は、表示日そのものでまとめる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    // 休場日は「その日が休み」という中身なので、米東部に直すとずれる。
    const holiday = event(api, { indicatorId: 'market_holiday', impact: 60,
      allDay: true, confidence: 'rule',
      start: api.zonedTime_(Y(2026, 11, 26), '00:00', 'Asia/Tokyo') });
    eq(api.releaseKey_(holiday, 'Asia/Tokyo'), 'market_holiday@2026-11-26');
    eq(api.releaseKey_(holiday, 'Asia/Tokyo'), api.eventUid_(holiday, 'Asia/Tokyo'),
       '終日の予定は、まとめる鍵と予定 ID の日付がそろっていること');
  });

  test('別の週の同じ指標は、まとめない', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const a = event(api, { indicatorId: 'us_jobless_claims', impact: 75,
      start: api.zonedTime_(Y(2026, 9, 3), '08:30', 'America/New_York') });
    const b = event(api, { indicatorId: 'us_jobless_claims', impact: 75,
      start: api.zonedTime_(Y(2026, 9, 10), '08:30', 'America/New_York') });
    eq(api.mergeEvents_([a, b], 'Asia/Tokyo').length, 2, '週次は毎週別の発表');
  });
});

// ---------------------------------------------------------------------------
suite('情報源が落ちているときの整理', () => {
  function withExisting(api, events) {
    return events.map((e) => {
      const r = api.toCalendarResource_(e);
      return { id: r.id, summary: r.summary, start: r.start, end: r.end,
               extendedProperties: r.extendedProperties };
    });
  }

  test('落ちた情報源の予定は消さない', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };
    const stored = withExisting(api, [event(api, { indicatorId: 'us_cpi', impact: 98,
      source: 'fred', start: api.zonedTime_(Y(2026, 9, 11), '08:30', 'America/New_York') })]);

    api.resetSourceHealth_();
    eq(api.buildPlan_('c', [], stored, ctx).deleted.length, 1,
       '情報源が元気なら、出てこなくなったものは消す');

    api.resetSourceHealth_();
    api.markSourceDown_('fred', 'つながらなかった');
    eq(api.buildPlan_('c', [], stored, ctx).deleted.length, 0,
       '落ちているだけなら残す');
    eq(api.downSources_(), ['fred']);
  });

  test('設定で外したものは、情報源が落ちていても消す', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };
    const stored = withExisting(api, [event(api, { indicatorId: 'us_cpi', impact: 98,
      source: 'fred', start: api.zonedTime_(Y(2026, 9, 11), '08:30', 'America/New_York') })]);
    api.resetSourceHealth_();
    api.markSourceDown_('fred', 'つながらなかった');

    api.CONFIG.filter.minImpact = 99;
    eq(api.buildPlan_('c', [], stored, ctx).deleted.length, 1,
       'しきい値を上げたぶんは、人が外したのだから消す');

    api.CONFIG.filter.minImpact = 55;
    api.CONFIG.filter.exclude = ['us_cpi'];
    eq(api.buildPlan_('c', [], stored, ctx).deleted.length, 1,
       'exclude も同じ');
  });

  test('落ちていない情報源の予定は、そのまま整理される', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    const ctx = { start: Y(2026, 9, 1), end: Y(2026, 9, 30), timezone: 'Asia/Tokyo' };
    const stored = withExisting(api, [event(api, { indicatorId: 'us_cpi', impact: 98,
      source: 'rules', start: api.zonedTime_(Y(2026, 9, 11), '08:30', 'America/New_York') })]);
    api.resetSourceHealth_();
    api.markSourceDown_('fred');
    eq(api.buildPlan_('c', [], stored, ctx).deleted.length, 1);
  });
});

// ---------------------------------------------------------------------------
suite('FRED の対応付けの重なり', () => {
  test('ひとつの release 名が2つの指標に当たったら知らせる', () => {
    const api = loadGas({ Calendar: fakeCalendar() });
    eq(api.fredReleaseOverlaps_(), [], 'いまのカタログには重なりが無いこと');

    api.INDICATORS.push({ id: 'x_dummy', name: 'ダミー', country: 'US', category: 'other',
                          impact: 50, time: '08:30', schedule: { type: 'none' },
                          fred_release: 'Consumer Price Index' });
    const found = api.fredReleaseOverlaps_();
    eq(found.length, 1, '重なりを1組として報告すること（両方向に2回言わない）');
    ok(found[0].indexOf('us_cpi') !== -1 && found[0].indexOf('x_dummy') !== -1, found[0]);
    ok(api.catalogProblems_().length > 0, 'カタログの点検でも拾われること');
    api.INDICATORS.pop();
  });
});

// 性質テスト（でたらめな設定で回す。詳しくは tests/props.js）
require('./props').registerPropertyTests({
  suite, test, eq, ok, loadGas, fakeCalendar,
});

process.exitCode = require('./assert').report();
