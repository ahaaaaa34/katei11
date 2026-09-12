/**
 * 「いま利用者に見えているもの」を1枚の文章に固めて、変化を差分で見る道具。
 *
 * これまでのテストは、性質（重複しない・落ちない・根拠を偽らない）を見てきた。
 * それでは**見え方が変わったこと**そのものは分からない。件名の並びを変えた、
 * 説明文の一行を消した、通知を減らした——どれも性質は保ったまま通る。
 *
 * ここでは日付も設定も固定して、出来上がりを丸ごと文章に落とす。
 * 差が出たら、それは「意図した変更か、事故か」を人が決める合図になる。
 *
 *   node tools/golden.js            いまの出来上がりと tests/golden.txt を比べる
 *   node tools/golden.js --update   いまの出来上がりで tests/golden.txt を作り直す
 */

const fs = require('fs');
const path = require('path');
const { loadGas, fakeCalendar } = require('../tests/harness');

const GOLDEN = path.join(__dirname, '..', 'tests', 'golden.txt');

/** 通信を使わず、日付も設定も固定した状態で作る。 */
function render() {
  const api = loadGas({
    Calendar: fakeCalendar(),
    properties: { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)' },
    UrlFetchApp: {
      fetch: () => { throw new Error('golden では通信しません'); },
      fetchAll: (rs) => rs.map(() => ({ getResponseCode: () => 503,
                                        getContentText: () => '' })),
    },
  });
  // 通信する情報源は落とす（応答が変われば出来上がりも変わるため）。
  Object.assign(api.CONFIG.providers, {
    fred: false, earnings: false, investing: false,
    fomcAutoFetch: false, officialTimes: false,
  });

  const ctx = api.syncWindow_(api.ymd_(2026, 9, 11));
  const events = api.collectEvents_(ctx)
    .concat(api.weeklyDigestEvents_(api.collectEvents_(ctx), ctx));

  const lines = [];
  lines.push('# 出来上がりの見本');
  lines.push('#');
  lines.push('# 基準日 2026-09-11 / 既定の設定 / 通信する情報源は無効');
  lines.push('# 差が出たときは、意図した変更かどうかを確かめてから');
  lines.push('# node tools/golden.js --update で作り直すこと。');
  lines.push('');
  lines.push('期間 ' + api.dateKey_(ctx.start) + ' 〜 ' + api.dateKey_(ctx.end)
             + ' / ' + events.length + ' 件');
  lines.push('');

  events
    .slice()
    .sort((a, b) => (a.start - b.start) || (a.indicatorId < b.indicatorId ? -1 : 1))
    .forEach((event) => {
      const r = api.toCalendarResource_(event);
      const when = r.start.date
        ? r.start.date + ' 終日      '
        : api.formatClock_(event.start, api.CONFIG.timezone).date + '('
          + api.formatClock_(event.start, api.CONFIG.timezone).weekday + ') '
          + api.formatClock_(event.start, api.CONFIG.timezone).time;
      lines.push(when + '  ' + r.summary);
      lines.push('    色 ' + (r.colorId || 'なし')
        + ' / 通知 ' + (r.reminders.overrides.map((m) => m.minutes).join(',') || 'なし')
        + ' / 日付の根拠 ' + event.confidence
        + ' / 時刻の根拠 ' + event.timeSource);
    });

  // 説明文は代表的なものだけ全文を載せる（全部載せると差分が読めなくなる）。
  ['us_cpi', 'us_fomc_rate', 'market_holiday', 'digest_weekly'].forEach((id) => {
    const event = events.find((e) => e.indicatorId === id);
    if (!event) return;
    lines.push('');
    lines.push('--- ' + id + ' の説明文 ---');
    api.renderDescription_(event).split('\n').forEach((l) => lines.push('  ' + l));
  });

  return lines.join('\n') + '\n';
}

const now = render();
const update = process.argv.indexOf('--update') !== -1;

if (update || !fs.existsSync(GOLDEN)) {
  fs.writeFileSync(GOLDEN, now);
  console.log((fs.existsSync(GOLDEN) ? '更新' : '作成') + 'しました: tests/golden.txt');
  process.exit(0);
}

const approved = fs.readFileSync(GOLDEN, 'utf8');
if (approved === now) {
  console.log('出来上がりは見本どおりです（' + now.split('\n').length + ' 行）');
  process.exit(0);
}

const a = approved.split('\n');
const b = now.split('\n');
console.log('出来上がりが見本と違います。\n');
let shown = 0;
for (let i = 0; i < Math.max(a.length, b.length) && shown < 40; i++) {
  if (a[i] === b[i]) continue;
  if (a[i] !== undefined) console.log('  - ' + a[i]);
  if (b[i] !== undefined) console.log('  + ' + b[i]);
  shown++;
}
console.log('\n意図した変更なら node tools/golden.js --update で見本を作り直してください。');
process.exit(1);
