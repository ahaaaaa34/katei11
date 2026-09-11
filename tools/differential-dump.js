/**
 * 差分テスト（その1）: JS 側の計算結果をそのまま吐き出す。
 *
 * 実装とテストが同じ思い込みを共有していると、そのぶんは永久に見つからない。
 * ここで出した答えを tools/differential.py が独立実装と突き合わせる。
 *
 *   node tools/differential-dump.js > /tmp/dump.json
 *   python3 tools/differential.py /tmp/dump.json
 *
 * あるいは npm run diff。
 */
const { loadGas, fakeCalendar } = require('../tests/harness');
const G = loadGas({ Calendar: fakeCalendar() });

const out = { zoned: [], local: [], holidays: {}, market: {}, early: {},
              easter: {}, rules: {}, sha1: [], period: [], businessNear: [] };

const TZS = ['Asia/Tokyo', 'America/New_York', 'UTC', 'Europe/London',
             'Australia/Sydney', 'America/Los_Angeles', 'Europe/Berlin',
             'Asia/Shanghai', 'America/Chicago', 'Asia/Kolkata'];
const TIMES = ['00:00', '08:30', '10:00', '13:00', '14:00', '16:15', '23:45'];

// --- 1. 現地の壁時計 -> 絶対時刻 ---
for (let y = 2024; y <= 2030; y++) {
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= 28; d += 3) {
      TZS.forEach((tz) => {
        TIMES.forEach((t) => {
          const instant = G.zonedTime_(G.ymd_(y, m, d), t, tz);
          out.zoned.push([y, m, d, t, tz, instant.toISOString()]);
        });
      });
    }
  }
}

// --- 2. 絶対時刻 -> 現地の日付 ---
let seed = 12345;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
for (let i = 0; i < 4000; i++) {
  const ms = Date.UTC(2024, 0, 1) + Math.floor(rnd() * 7 * 365 * 86400000);
  const tz = TZS[Math.floor(rnd() * TZS.length)];
  const instant = new Date(ms);
  out.local.push([instant.toISOString(), tz, G.dateKey_(G.localDate_(instant, tz))]);
}

// --- 3. 休日・市場の休場・短縮取引・復活祭 ---
for (let y = 2020; y <= 2035; y++) {
  out.holidays[y] = Object.keys(G.federalHolidays_(y)).sort();
  out.market[y] = Object.keys(G.marketHolidays_(y)).sort();
  out.early[y] = Object.keys(G.marketEarlyCloses_(y)).sort();
  out.easter[y] = G.dateKey_(G.easter_(y));
}

// --- 4. 発表規則の展開 ---
const RULES = [
  ['weekly_thu', { type: 'weekly', weekday: 'thu' }],
  ['weekly_wed', { type: 'weekly', weekday: 'wed' }],
  ['nbd_1', { type: 'nth_business_day', n: 1 }],
  ['nbd_3', { type: 'nth_business_day', n: 3 }],
  ['nbd_5', { type: 'nth_business_day', n: 5 }],
  ['nbd_last', { type: 'nth_business_day', n: -1 }],
  ['nbd_last2', { type: 'nth_business_day', n: -2 }],
  ['nw_fri_1', { type: 'nth_weekday', weekday: 'fri', n: 1 }],
  ['nw_fri_2', { type: 'nth_weekday', weekday: 'fri', n: 2 }],
  ['nw_fri_last', { type: 'nth_weekday', weekday: 'fri', n: -1 }],
  ['nw_tue_last', { type: 'nth_weekday', weekday: 'tue', n: -1 }],
  ['nw_thu_3', { type: 'nth_weekday', weekday: 'thu', n: 3 }],
  ['dom_1', { type: 'day_of_month', day: 1 }],
  ['dom_12', { type: 'day_of_month', day: 12 }],
  ['dom_15', { type: 'day_of_month', day: 15 }],
  ['dom_27', { type: 'day_of_month', day: 27 }],
  ['dom_28', { type: 'day_of_month', day: 28 }],
  ['nw_fri_last_q', { type: 'nth_weekday', weekday: 'fri', n: -1, months: [1, 4, 7, 10] }],
  ['dom_7_q', { type: 'day_of_month', day: 7, months: [2, 5, 8, 11] }],
];
const from = G.ymd_(2024, 1, 1);
const to = G.ymd_(2032, 12, 31);
RULES.forEach((pair) => {
  out.rules[pair[0]] = G.ruleDates_(pair[1], from, to).map(G.dateKey_);
});

// --- 5. SHA-1 と予定 ID ---
['', 'abc', 'us_cpi@2026-09-11', '米 消費者物価指数', '🔴🇺🇸',
 'a'.repeat(1000), 'x@2026-01-01'].forEach((text) => {
  out.sha1.push([text, G.sha1Hex_(text), G.base32hex_(G.sha1Bytes_(text))]);
});
for (let i = 0; i < 500; i++) {
  const text = 'ind' + Math.floor(rnd() * 1e9) + '@2026-' + String(1 + Math.floor(rnd() * 12)).padStart(2, '0')
    + '-' + String(1 + Math.floor(rnd() * 28)).padStart(2, '0');
  out.sha1.push([text, G.sha1Hex_(text), G.base32hex_(G.sha1Bytes_(text))]);
}

// --- 6. 対象期間ラベル ---
for (let y = 2025; y <= 2028; y++) {
  for (let m = 1; m <= 12; m++) {
    [-3, -2, -1, 0, 1, 2].forEach((off) => {
      out.period.push([y, m, off, G.periodLabel_(G.ymd_(y, m, 15), off)]);
    });
  }
}

// --- 7. 月内の営業日への寄せ ---
for (let y = 2024; y <= 2032; y++) {
  for (let m = 1; m <= 12; m++) {
    [1, 7, 12, 15, 26, 27, 28].forEach((d) => {
      out.businessNear.push([y, m, d, G.dateKey_(G.businessDayNearDay_(y, m, d))]);
    });
  }
}

process.stdout.write(JSON.stringify(out));
