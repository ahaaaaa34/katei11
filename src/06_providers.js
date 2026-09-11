/**
 * 情報源。上から順に「通信不要 → 通信あり」。
 *
 * どのプロバイダも、取得できなければ空配列を返して静かに諦める。
 * ひとつ死んでも同期全体は続く（ルール計算だけでも実用的な予定表が出る）。
 */

// ---------------------------------------------------------------------------
// rules — 発表日をローカルで計算する。通信も API キーも要らない土台。
// ---------------------------------------------------------------------------

function providerRules_(ctx) {
  const events = [];
  // 米東部の日付と表示タイムゾーンの日付は最大1日ずれる。取りこぼさない
  // よう数日ぶん広げて展開し、最後に表示日で絞る。
  const from = addDays_(ctx.start, -3);
  const to = addDays_(ctx.end, 3);

  indicatorsWithRules_().forEach(function (indicator) {
    ruleDates_(indicator.schedule, from, to).forEach(function (date) {
      const start = zonedTime_(date, indicator.time, indicatorTimezone_(indicator));
      if (!inDisplayWindow_(start, ctx)) return;
      events.push(makeEvent_({
        indicatorId: indicator.id,
        title: indicator.name,
        start: start,
        end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
        impact: indicator.impact,
        country: indicator.country,
        category: indicator.category,
        source: 'rules',
        confidence: ruleIsExact_(indicator) ? 'rule' : 'estimated',
        period: periodLabel_(date, indicator.period_offset || 0),
        note: indicator.why,
        url: indicator.url,
      }));
    });
  });
  return events;
}

// ---------------------------------------------------------------------------
// fomc — 会合日程から、記者会見・議事要旨・ベージュブックを導出する。
// ---------------------------------------------------------------------------

const MINUTES_LAG_DAYS = 21;      // 議事要旨は会合2日目の3週間後
const AUTO_ORIGIN_NOTE =
  '\n\n※ この会合日程は Fed の公式ページから取得したものです。';
const BEIGE_BOOK_LEAD_DAYS = 14;  // ベージュブックは会合の2週間前

function providerFomc_(ctx) {
  const banks = {
    fomc: { rate: 'us_fomc_rate', presser: 'us_fomc_presser' },
    boj: { rate: 'jp_boj_decision', presser: null },
    ecb: { rate: 'eu_ecb_decision', presser: null },
  };
  const events = [];

  Object.keys(banks).forEach(function (bank) {
    allMeetings_(bank).forEach(function (meeting) {
      const day = parseDateKey_(meeting.date);
      if (!day) return;   // 手入力が壊れていても、そこだけ飛ばす
      const sep = !!meeting.sep;
      // 自動取得ぶんは、どこから来た日程かを説明文に残す。
      const origin = meeting.auto ? AUTO_ORIGIN_NOTE : '';
      // 会合日そのものの確からしさ。議事要旨などの派生は、そこから
      // 「3週間後」という慣例で導いているので rule 止まりにする。
      const base = meeting.confidence || 'estimated';
      const derived = confidenceRank_(base) > confidenceRank_('rule') ? 'rule' : base;

      const rate = indicator_(banks[bank].rate);
      if (!rate) return;
      let note = rate.why;
      if (sep) {
        note += '\n【ドットチャート公表回】経済見通し(SEP)が同時発表される会合。' +
                '利下げ回数の織り込みが一気に書き換わるため、通常会合より値動きが大きい。';
      }
      events.push(fomcEvent_(rate, day, rate.impact, note + origin, null,
                             { sep: sep, bank: bank, auto: !!meeting.auto }, base));

      const presser = banks[bank].presser ? indicator_(banks[bank].presser) : null;
      if (presser) {
        events.push(fomcEvent_(presser, day, Math.min(100, presser.impact + (sep ? 2 : 0)),
                               presser.why + origin, null,
                               { sep: sep, auto: !!meeting.auto }));
      }

      if (bank === 'fomc') {
        const minutes = indicator_('us_fomc_minutes');
        if (minutes) {
          events.push(fomcEvent_(minutes, addDays_(day, MINUTES_LAG_DAYS), minutes.impact,
                                 minutes.why + origin,
                                 day.getUTCFullYear() + '年' + (day.getUTCMonth() + 1) + '月' +
                                 day.getUTCDate() + '日会合分', null, derived));
        }
        const beige = indicator_('us_beige_book');
        if (beige) {
          events.push(fomcEvent_(beige, addDays_(day, -BEIGE_BOOK_LEAD_DAYS), beige.impact,
                                 beige.why + origin, null, null, derived));
        }
      }
    });
  });

  return events.filter(function (event) { return inDisplayWindow_(event.start, ctx); });
}

function fomcEvent_(indicator, day, impact, note, period, extra, confidence) {
  const start = zonedTime_(day, indicator.time, indicatorTimezone_(indicator));
  return makeEvent_({
    indicatorId: indicator.id,
    title: indicator.name,
    start: start,
    end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
    impact: impact,
    country: indicator.country,
    category: indicator.category,
    source: 'fomc',
    confidence: confidence || 'estimated',
    period: period || null,
    note: note,
    url: indicator.url,
    extra: extra || {},
  });
}

// ---------------------------------------------------------------------------
// market — 休場・短縮取引・SQ・指数リバランス。取引所のルールから計算する。
// ---------------------------------------------------------------------------

const QUARTER_MONTHS = [3, 6, 9, 12];

function providerMarket_(ctx) {
  const events = [];
  for (let year = ctx.start.getUTCFullYear(); year <= ctx.end.getUTCFullYear(); year++) {
    pushClosures_(events, year, ctx);
    pushExpiries_(events, year);
    pushRebalance_(events, year);
  }
  return events.filter(function (event) { return inDisplayWindow_(event.start, ctx); });
}

function pushClosures_(events, year, ctx) {
  const holiday = indicator_('market_holiday');
  if (holiday) {
    const table = marketHolidays_(year);
    Object.keys(table).forEach(function (key) {
      // 終日予定は表示タイムゾーンの深夜に置く。どの時差の人が見ても
      // 「米国の休場日」がその日付として出るようにするため。
      const start = zonedTime_(parseDateKey_(key), '00:00', ctx.timezone);
      events.push(makeEvent_({
        indicatorId: holiday.id,
        title: holiday.name + ' (' + table[key] + ')',
        start: start,
        end: new Date(start.getTime() + 86400000),
        impact: holiday.impact,
        country: holiday.country,
        category: holiday.category,
        source: 'market',
        confidence: 'rule',
        allDay: true,
        note: table[key] + ' のため NYSE・ナスダックは終日休場。\n' + holiday.why,
      }));
    });
  }

  const early = indicator_('market_early_close');
  if (early) {
    const table = marketEarlyCloses_(year);
    Object.keys(table).forEach(function (key) {
      const start = zonedTime_(parseDateKey_(key), early.time, ET);
      events.push(makeEvent_({
        indicatorId: early.id,
        title: early.name + ' (' + table[key] + ')',
        start: start,
        end: new Date(start.getTime() + (early.duration || 30) * 60000),
        impact: early.impact,
        country: early.country,
        category: early.category,
        source: 'market',
        confidence: 'rule',
        note: table[key] + ' のため 13:00 ET で取引終了。\n' + early.why,
      }));
    });
  }
}

function pushExpiries_(events, year) {
  for (let month = 1; month <= 12; month++) {
    const thirdFriday = nthWeekday_(year, month, WEEKDAY_NUM.fri, 3);
    const quad = QUARTER_MONTHS.indexOf(month) !== -1;
    const indicator = indicator_(quad ? 'market_quad_witching' : 'market_opex');
    if (!indicator) continue;
    const start = zonedTime_(thirdFriday, indicator.time, ET);
    let note = indicator.why;
    if (quad) {
      note += '\n同日に S&P500 の四半期リバランスも執行され、引けの出来高が跳ね上がる。';
    }
    events.push(makeEvent_({
      indicatorId: indicator.id,
      title: indicator.name,
      start: start,
      end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
      impact: indicator.impact,
      country: indicator.country,
      category: indicator.category,
      source: 'market',
      confidence: 'rule',
      note: note,
    }));
  }
}

function pushRebalance_(events, year) {
  const indicator = indicator_('market_index_rebalance');
  if (!indicator) return;
  // ナスダック100の年次入替は12月第2金曜の引け後に発表され、
  // 第3金曜の引けでパッシブ資金が執行される。
  const announce = nthWeekday_(year, 12, WEEKDAY_NUM.fri, 2);
  const start = zonedTime_(announce, indicator.time, ET);
  events.push(makeEvent_({
    indicatorId: indicator.id,
    title: 'Nasdaq-100 年次銘柄入替 発表',
    start: start,
    end: new Date(start.getTime() + (indicator.duration || 30) * 60000),
    impact: indicator.impact,
    country: indicator.country,
    category: indicator.category,
    source: 'market',
    confidence: 'rule',
    note: '引け後に構成銘柄の入替が発表される。翌週の第3金曜の引けで' +
          'パッシブ資金が執行され、対象銘柄は前後で大きく動く。\n' + indicator.why,
  }));
}
