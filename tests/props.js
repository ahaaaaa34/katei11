/**
 * 性質テスト（デバッグ3周目）。
 *
 * 1周目は「根拠の経路の総当たり」、2周目は「時間をまたいだ状態遷移」で見た。
 * ここは3つめの見方として、**設定・情報源の生死・基準日をでたらめに振って、
 * どんな組み合わせでも崩れてはいけない性質**を突く。
 *
 * 個別の題材を人が思いつく限り並べるやり方だと、思いつかなかった組み合わせが
 * そのまま抜ける。逆に「何が起きても成り立つはずのこと」を書いておけば、
 * 人が想像していなかった組み合わせでも破れた瞬間に落ちる。
 *
 * 乱数は種を固定してあるので、失敗は必ず再現する（FUZZ_SEED で変えられる）。
 * 件数は FUZZ_N で増やせる。CI では既定の件数で回す。
 */

const SEED = Number(process.env.FUZZ_SEED || 20260911);
const CASES = Number(process.env.FUZZ_N || 90);

/** 種から決まる乱数（mulberry32）。Math.random は使わない。 */
function rng(seed) {
  let state = seed >>> 0;
  return function () {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TIMEZONES = ['Asia/Tokyo', 'America/New_York', 'UTC', 'Europe/London',
                   'Australia/Sydney', 'America/Los_Angeles'];

// ---------------------------------------------------------------------------
// 偽のネットワーク。情報源ごとに「生きている / 落ちている」を振れるようにする。
// ---------------------------------------------------------------------------

const FRED_RELEASES = [
  ['Consumer Price Index', 11], ['Producer Price Index', 12],
  ['Employment Situation', 4], ['Personal Income and Outlays', 26],
  ['Advance Monthly Sales for Retail and Food Services', 16],
];

function fredBody(ctx, pad) {
  const rows = [];
  for (let m = 0; m < 18; m++) {
    FRED_RELEASES.forEach(function (pair) {
      const date = new Date(Date.UTC(2026, m, pair[1] + (pad % 3)));
      rows.push({ release_id: 1, release_name: pair[0],
                  date: date.toISOString().slice(0, 10) });
    });
  }
  return JSON.stringify({ count: rows.length, release_dates: rows });
}

function investingBody(pad) {
  const rows = [];
  for (let m = 0; m < 18; m++) {
    const day = String(11 + (pad % 3)).padStart(2, '0');
    const month = String((m % 12) + 1).padStart(2, '0');
    const year = 2026 + Math.floor(m / 12);
    rows.push('<tr data-event-datetime="' + year + '/' + month + '/' + day
      + ' 12:45:00"><td class="left event">Core CPI (MoM)</td>'
      + '<td id="eventActual_1">0.2%</td><td id="eventForecast_1">0.3%</td>'
      + '<td id="eventPrevious_1">0.1%</td></tr>');
  }
  return JSON.stringify({ data: rows.join('') });
}

function earningsBody(url) {
  const date = url.split('date=')[1];
  // 木曜だけ NVDA が出る、という作り物。日付から決まるので毎回同じ。
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  const rows = weekday === 4
    ? [{ symbol: 'NVDA', name: 'NVIDIA Corp', time: 'time-after-hours',
         epsForecast: '$1.20', fiscalQuarterEnding: 'Oct/2026' }]
    : [];
  return JSON.stringify({ data: { rows: rows } });
}

/** 発表機関の予定表。日付も時刻もここが一次情報。 */
const SCHEDULE_RELEASES = [
  ['Consumer Price Index', 11, '08:30'], ['Producer Price Index', 12, '08:30'],
  ['Employment Situation', 4, '08:30'], ['Personal Income and Outlays', 26, '08:30'],
  ['Advance Monthly Sales for Retail and Food Services', 16, '10:00'],
];

function scheduleHtml(year, pad) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];
  const rows = [];
  for (let m = 0; m < 12; m++) {
    SCHEDULE_RELEASES.forEach(function (r) {
      rows.push('<tr><td>' + months[m] + ' ' + (r[1] + (pad % 3)) + ', ' + year
        + '</td><td>' + r[0] + ' for ' + months[(m + 11) % 12] + ' ' + year
        + '</td><td>' + r[2] + ' AM</td></tr>');
    });
  }
  return '<table>' + rows.join('') + '</table>';
}

const FOMC_HTML_YEAR = 2028;
const FOMC_HTML_DAYS = [[1, 25, 26], [3, 14, 15], [4, 25, 26], [6, 13, 14],
                        [7, 25, 26], [9, 12, 13], [10, 31, 1], [12, 12, 13]];

function fomcHtml() {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];
  const panels = FOMC_HTML_DAYS.map(function (row, index) {
    const name = months[row[0]];
    const second = row[2] < row[1] ? months[row[0] + 1] + ' ' + row[2] : String(row[2]);
    return '<div class="fomc-meeting__month"><strong>' + name + '</strong></div>'
      + '<div class="fomc-meeting__date">' + row[1] + '-' + second
      + (index % 2 === 0 ? '*' : '') + '</div>';
  });
  return '<div class="panel panel-default"><div class="panel-heading">'
    + FOMC_HTML_YEAR + ' FOMC Meetings</div>' + panels.join('') + '</div>';
}

function fakeNetwork(up, pad) {
  function respond(url) {
    const ok = (body) => ({ getResponseCode: () => 200, getContentText: () => body });
    if (url.indexOf('stlouisfed') !== -1) {
      if (!up.fred) throw new Error('fred down');
      return ok(fredBody(null, pad));
    }
    if (url.indexOf('investing.com') !== -1) {
      if (!up.investing) throw new Error('investing down');
      return ok(investingBody(pad));
    }
    if (url.indexOf('api.nasdaq.com') !== -1) {
      if (!up.earnings) throw new Error('earnings down');
      return ok(earningsBody(url));
    }
    if (url.indexOf('federalreserve.gov') !== -1) {
      if (!up.fomc) throw new Error('fed down');
      return ok(fomcHtml());
    }
    if (url.indexOf('bls.gov') !== -1 || url.indexOf('bea.gov') !== -1
        || url.indexOf('census.gov') !== -1) {
      if (!up.official) throw new Error('schedule down');
      const year = (/(\d{4})/.exec(url) || [])[1] || '2026';
      return ok(scheduleHtml(Number(year), pad));
    }
    throw new Error('想定外の URL: ' + url);
  }
  return {
    fetch: (url) => respond(url),
    fetchAll: (requests) => requests.map((r) => {
      try { return respond(r.url); } catch (err) {
        return { getResponseCode: () => 503, getContentText: () => '' };
      }
    }),
  };
}

// ---------------------------------------------------------------------------

function registerPropertyTests(env) {
  const { suite, test, eq, ok, loadGas, fakeCalendar } = env;

  /** でたらめな設定をひとつ作る。 */
  function draw(next) {
    const pickOne = (list) => list[Math.floor(next() * list.length)];
    const bool = (p) => next() < (p === undefined ? 0.5 : p);
    return {
      timezone: pickOne(TIMEZONES),
      daysAhead: 3 + Math.floor(next() * 110),
      daysBack: Math.floor(next() * 20),
      minImpact: 20 + Math.floor(next() * 70),
      allDay: bool(0.3),
      impactEmoji: bool(0.7),
      countryFlag: bool(0.7),
      showScore: bool(0.4),
      providers: {
        rules: bool(0.9), fomc: bool(0.8), market: bool(0.7),
        fred: bool(0.7), earnings: bool(0.5), investing: bool(0.5),
        fomcAutoFetch: bool(0.6), officialTimes: bool(0.7),
      },
      up: { fred: bool(0.7), investing: bool(0.7), earnings: bool(0.7),
            fomc: bool(0.7), official: bool(0.7) },
      today: new Date(Date.UTC(2026, Math.floor(next() * 20), 1 + Math.floor(next() * 28))),
      pad: Math.floor(next() * 3),
    };
  }

  function build(spec, calendar, store) {
    const api = loadGas({
      Calendar: calendar,
      properties: store,
      UrlFetchApp: fakeNetwork(spec.up, spec.pad),
    });
    api.CONFIG.timezone = spec.timezone;
    api.CONFIG.window.daysAhead = spec.daysAhead;
    api.CONFIG.window.daysBack = spec.daysBack;
    api.CONFIG.filter.minImpact = spec.minImpact;
    Object.assign(api.CONFIG.display, {
      allDay: spec.allDay, impactEmoji: spec.impactEmoji,
      countryFlag: spec.countryFlag, showScore: spec.showScore,
    });
    Object.assign(api.CONFIG.providers, spec.providers);
    return api;
  }

  /** 1回ぶんの同期。実際の syncCalendar と同じ順序で組み立てる。 */
  function runOnce(spec, calendar, store) {
    const api = build(spec, calendar, store);
    const ctx = api.syncWindow_(api.localDate_(spec.today, spec.timezone));
    const collected = api.collectEvents_(ctx);
    const existing = api.listManagedEvents_('c', ctx.start, ctx.end);
    const enriched = api.inheritFromExisting_(collected, existing);
    const plan = api.buildPlan_('c', enriched, existing, ctx);
    api.applyPlan_(plan);
    Object.keys(api._store).forEach((k) => { store[k] = api._store[k]; });
    return { api, ctx, plan, collected };
  }

  function writes(plan) {
    return plan.created.length + plan.updated.length + plan.deleted.length;
  }

  function newStore() {
    return { _calendarId: 'c', _calendarName: '経済指標 (Nasdaq)', FRED_API_KEY: 'k' };
  }

  /** 失敗したときに、どの組み合わせだったか分かるようにする。 */
  function label(spec) {
    const on = Object.keys(spec.providers).filter((k) => spec.providers[k]).join(',');
    const down = Object.keys(spec.up).filter((k) => !spec.up[k]).join(',') || 'なし';
    return '[tz=' + spec.timezone + ' 窓=-' + spec.daysBack + '/+' + spec.daysAhead
      + ' しきい値=' + spec.minImpact + ' 終日=' + spec.allDay
      + ' 有効=' + on + ' 停止=' + down
      + ' 基準日=' + spec.today.toISOString().slice(0, 10) + ']';
  }

  // -------------------------------------------------------------------------
  suite('性質: どんな設定・情報源の生死でも崩れないこと', () => {
    // すべての組み合わせをひとつずつ回し、性質ごとに違反を集める。
    // どれかひとつでも破れたら、その組み合わせを添えて落とす。
    const broken = {};
    const record = (name, spec, detail) => {
      if (!broken[name]) broken[name] = [];
      if (broken[name].length < 3) broken[name].push(label(spec) + ' ' + detail);
    };

    const next = rng(SEED);
    let totalEvents = 0;
    let casesWithEvents = 0;

    for (let i = 0; i < CASES; i++) {
      const spec = draw(next);
      const calendar = fakeCalendar();
      const store = newStore();

      let first;
      try {
        first = runOnce(spec, calendar, store);
      } catch (err) {
        record('同期が例外で落ちない', spec, String(err && err.stack || err));
        continue;
      }
      const { api, ctx, plan } = first;
      totalEvents += plan.created.length;
      if (plan.created.length) casesWithEvents++;

      // --- 書き込んだ姿そのものを調べる ---
      const seenId = {};
      [...calendar.events.values()].forEach((item) => {
        const props = (item.extendedProperties || {}).private || {};

        if (seenId[item.id]) record('予定 ID が重ならない', spec, item.id);
        seenId[item.id] = true;

        // 表示日は必ず同期範囲の中
        const day = api.resourceDisplayDate_(item);
        if (!day || day.getTime() < ctx.start.getTime()
            || day.getTime() > ctx.end.getTime()) {
          record('書き込んだ予定は同期範囲の中にある', spec,
                 item.id + ' → ' + (day && day.toISOString()));
        }

        // 終日設定なら日付だけ、そうでなければ時刻つき
        const isAllDay = !!(item.start && item.start.date);
        if (spec.allDay && !isAllDay) {
          record('終日設定なら時刻を持たない', spec, item.id);
        }
        if (!isAllDay && !(item.start.dateTime && item.end.dateTime)) {
          record('時刻つきなら開始と終了がそろっている', spec, item.id);
        }
        if (!isAllDay && !(new Date(item.end.dateTime) > new Date(item.start.dateTime))) {
          record('終了は開始より後', spec, item.id);
        }

        // 覚えておいた開始時刻は、実際に書いた開始時刻と一致する
        if (!isAllDay && props.at !== item.start.dateTime) {
          record('覚えた時刻と書いた時刻が一致する', spec,
                 item.id + ' ' + props.at + ' / ' + item.start.dateTime);
        }

        // 根拠を偽らない：外部の情報源がひとつも生きていない回で
        // 「公式の日程」を名乗る予定が出てはいけない。
        const anyOfficial = (spec.providers.fred && spec.up.fred)
          || (spec.providers.earnings && spec.up.earnings)
          || (spec.providers.fomcAutoFetch && spec.up.fomc)
          || (spec.providers.officialTimes && spec.up.official);
        if (props.confidence === 'official' && !anyOfficial) {
          record('情報源なしに公式を名乗らない', spec, item.id + ' ' + props.source);
        }
        if (['official', 'reported', 'rule', 'estimated'].indexOf(props.confidence) < 0) {
          record('根拠は4種類のいずれか', spec, item.id + ' ' + props.confidence);
        }

        // 時刻の出どころを偽らない。一次情報でないものには必ず断りが付く。
        const NOTE = { official: '', reported: '（発表時刻は集計サイト由来）',
                       fallback: '（発表時刻は未確認の暫定値）' };
        const expected = NOTE[props.ts];
        const footer = (item.description || '').split('\n').pop();
        if (expected === undefined) {
          record('時刻の出どころは3種類のいずれか', spec, item.id + ' ' + props.ts);
        } else if (!isAllDay && footer.indexOf(expected) === -1) {
          record('時刻の断りは出どころどおり', spec,
                 item.id + ' ts=' + props.ts + ' 末尾=' + footer);
        }
        if (isAllDay && (item.description || '').indexOf('発表時刻は') !== -1) {
          record('終日なのに時刻の断りを書かない', spec, item.id);
        }
        if (!isAllDay && props.ts === 'fallback'
            && (item.description || '').indexOf('未確認の暫定値') === -1) {
          record('暫定値は必ず未確認だと書く', spec, item.id);
        }
        if (props.ts === 'official'
            && !(spec.providers.officialTimes && spec.up.official)) {
          record('予定表なしに一次情報の時刻を名乗らない', spec, item.id);
        }

        // Google の受け入れ範囲
        if (!item.summary || item.summary.length > 1024) {
          record('件名は空でなく長すぎない', spec, item.id + ' ' + item.summary);
        }
        if (!item.description || item.description.length > 8192) {
          record('説明は空でなく長すぎない', spec,
                 item.id + ' ' + (item.description || '').length + '文字');
        }
        if (item.colorId !== undefined && !/^([1-9]|1[01])$/.test(item.colorId)) {
          record('色 ID は 1〜11', spec, item.id + ' ' + item.colorId);
        }
        const overrides = ((item.reminders || {}).overrides) || [];
        overrides.forEach((r) => {
          if (!(Number.isInteger(r.minutes) && r.minutes >= 0 && r.minutes <= 40320)) {
            record('通知は Google が受け取れる分数', spec, item.id + ' ' + r.minutes);
          }
        });

        // しきい値より下のものが混ざっていない
        if (Number(props.impact) < spec.minImpact) {
          record('しきい値より下は入らない', spec,
                 item.id + ' ' + props.impact + ' < ' + spec.minImpact);
        }

        // 書いた姿から読み戻せる
        const back = api.eventFromResource_(item);
        if (!back) {
          record('書いた予定は読み戻せる', spec, item.id);
        } else if (back.indicatorId !== props.indicator
                   || back.confidence !== props.confidence) {
          record('読み戻しても中身が変わらない', spec, item.id);
        }
      });

      // --- 同じ入力をもう一度：1文字も書き込みが起きてはいけない ---
      let second;
      try {
        second = runOnce(spec, calendar, store);
      } catch (err) {
        record('2回目も例外で落ちない', spec, String(err && err.stack || err));
        continue;
      }
      if (writes(second.plan) !== 0) {
        record('同じ入力なら2回目は何も書かない', spec,
               '作成' + second.plan.created.length
               + ' 更新' + second.plan.updated.length
               + ' 削除' + second.plan.deleted.length
               + ' 例: ' + (second.plan.updated[0] || second.plan.created[0]
                            || second.plan.deleted[0] || {}).resource);
      }

      // --- 外部の情報源が全部落ちた3回目：日付も中身も動かさない ---
      const blackout = Object.assign({}, spec,
        { up: { fred: false, investing: false, earnings: false, fomc: false } });
      const before = [...calendar.events.values()].map((e) => ({
        id: e.id, at: (e.extendedProperties.private || {}).at,
        a: (e.extendedProperties.private || {}).a,
        f: (e.extendedProperties.private || {}).f,
      }));
      let third;
      try {
        third = runOnce(blackout, calendar, store);
      } catch (err) {
        record('全滅しても例外で落ちない', spec, String(err && err.stack || err));
        continue;
      }
      if (writes(third.plan) !== 0) {
        record('情報源が全滅しても何も書き換えない', spec,
               '作成' + third.plan.created.length
               + ' 更新' + third.plan.updated.length
               + ' 削除' + third.plan.deleted.length);
      }
      const after = [...calendar.events.values()];
      if (after.length !== before.length) {
        record('情報源が全滅しても予定が減らない', spec,
               before.length + ' → ' + after.length);
      }
      before.forEach((was) => {
        const now = calendar.events.get(was.id);
        if (!now) { record('情報源が全滅しても予定が消えない', spec, was.id); return; }
        const props = now.extendedProperties.private || {};
        if (props.at !== was.at || props.a !== was.a || props.f !== was.f) {
          record('情報源が全滅しても時刻と数値が消えない', spec, was.id);
        }
      });
    }

    // -----------------------------------------------------------------------
    // 続けて、時間や設定を動かしたときの性質も同じやり方で見る。
    // -----------------------------------------------------------------------
    const next2 = rng(SEED ^ 0x5bf03635);
    const MOVING = Math.max(2, Math.floor(CASES / 6));

    for (let i = 0; i < MOVING; i++) {
      const spec = draw(next2);
      // 情報源は全部生きている前提で、動かす方の性質だけを見る。
      spec.up = { fred: true, investing: true, earnings: true, fomc: true };
      const calendar = fakeCalendar();
      const store = newStore();

      let base;
      try {
        base = runOnce(spec, calendar, store);
      } catch (err) {
        record('動かす題材でも例外で落ちない', spec, String(err && err.stack || err));
        continue;
      }

      // --- 同じ発表が2つ入っていないか（地元の日付で見る） ---
      const byRelease = {};
      [...calendar.events.values()].forEach((item) => {
        const back = base.api.eventFromResource_(item);
        if (!back) return;
        const key = base.api.releaseKey_(back, spec.timezone);
        (byRelease[key] = byRelease[key] || []).push(item.id);
      });
      Object.keys(byRelease).forEach((key) => {
        if (byRelease[key].length > 1) {
          record('同じ発表が2つ入らない', spec, key + ' → ' + byRelease[key].join(', '));
        }
      });

      // --- しきい値を上げたら、下回るものはちゃんと消える ---
      const strict = Object.assign({}, spec, { minImpact: 99 });
      let after;
      try {
        after = runOnce(strict, calendar, store);
      } catch (err) {
        record('しきい値を上げても例外で落ちない', spec, String(err && err.stack || err));
        continue;
      }
      [...calendar.events.values()].forEach((item) => {
        const props = item.extendedProperties.private || {};
        if (Number(props.impact) < 99) {
          record('しきい値を上げたら下回るものは消える', spec,
                 item.id + ' ' + props.impact);
        }
      });

      // --- 戻したら、元どおりに復活する ---
      let back;
      try {
        runOnce(spec, calendar, store);
        back = runOnce(spec, calendar, store);
      } catch (err) {
        record('しきい値を戻しても例外で落ちない', spec, String(err && err.stack || err));
        continue;
      }
      if (writes(back.plan) !== 0) {
        record('しきい値を戻したら落ち着く', spec,
               '作成' + back.plan.created.length + ' 更新' + back.plan.updated.length
               + ' 削除' + back.plan.deleted.length);
      }
      const revived = [...calendar.events.values()].length;
      if (revived !== base.plan.created.length) {
        record('しきい値を戻したら同じ件数に戻る', spec,
               base.plan.created.length + ' → ' + revived);
      }
    }

    // --- 基準日を1日ずつ進めても、無駄な書き換えが起きない ---
    const next3 = rng(SEED ^ 0x1d872b41);
    const SLIDING = Math.max(1, Math.floor(CASES / 12));
    for (let i = 0; i < SLIDING; i++) {
      const spec = draw(next3);
      spec.up = { fred: true, investing: true, earnings: true, fomc: true };
      spec.daysAhead = 30;
      spec.daysBack = 5;
      const calendar = fakeCalendar();
      const store = newStore();
      let churn = 0;
      let days = 0;
      try {
        for (let d = 0; d < 14; d++) {
          const moved = Object.assign({}, spec,
            { today: new Date(spec.today.getTime() + d * 86400000) });
          // 同じ日に2回走らせる（朝と夕方の自動実行に相当）
          const morning = runOnce(moved, calendar, store);
          const evening = runOnce(moved, calendar, store);
          if (writes(evening.plan) !== 0) {
            record('同じ日の2回目は何も書かない', spec,
                   'd=' + d + ' 更新' + evening.plan.updated.length
                   + ' 削除' + evening.plan.deleted.length);
          }
          // 1日進めたぶんの出入りは、窓の端の数日ぶんで収まるはず
          churn += morning.plan.updated.length + morning.plan.deleted.length;
          days++;
        }
      } catch (err) {
        record('日をまたいでも例外で落ちない', spec, String(err && err.stack || err));
        continue;
      }
      if (churn > days * 3) {
        record('日が進んでも書き換えは端の数件で収まる', spec,
               days + '日で ' + churn + ' 件の更新・削除');
      }
    }

    // 性質ごとにひとつのテストとして報告する（どれが破れたか一目で分かる）。
    const NAMES = [
      '同期が例外で落ちない', '2回目も例外で落ちない', '全滅しても例外で落ちない',
      '予定 ID が重ならない', '書き込んだ予定は同期範囲の中にある',
      '終日設定なら時刻を持たない', '時刻つきなら開始と終了がそろっている',
      '終了は開始より後', '覚えた時刻と書いた時刻が一致する',
      '情報源なしに公式を名乗らない', '根拠は4種類のいずれか',
      '時刻の出どころは3種類のいずれか', '時刻の断りは出どころどおり',
      '予定表なしに一次情報の時刻を名乗らない',
      '終日なのに時刻の断りを書かない', '暫定値は必ず未確認だと書く',
      '件名は空でなく長すぎない', '説明は空でなく長すぎない', '色 ID は 1〜11',
      '通知は Google が受け取れる分数', 'しきい値より下は入らない',
      '書いた予定は読み戻せる', '読み戻しても中身が変わらない',
      '同じ入力なら2回目は何も書かない',
      '情報源が全滅しても何も書き換えない', '情報源が全滅しても予定が減らない',
      '情報源が全滅しても予定が消えない', '情報源が全滅しても時刻と数値が消えない',
      '動かす題材でも例外で落ちない', '同じ発表が2つ入らない',
      'しきい値を上げても例外で落ちない', 'しきい値を上げたら下回るものは消える',
      'しきい値を戻しても例外で落ちない', 'しきい値を戻したら落ち着く',
      'しきい値を戻したら同じ件数に戻る',
      '日をまたいでも例外で落ちない', '同じ日の2回目は何も書かない',
      '日が進んでも書き換えは端の数件で収まる',
    ];
    NAMES.forEach((name) => {
      test(name, () => {
        const hits = broken[name] || [];
        ok(!hits.length, hits.length + ' 件の反例:\n    ' + hits.join('\n    '));
      });
    });

    test('題材そのものが空回りしていない', () => {
      // 反例が出ないのは「そもそも予定が1件も作られていないから」かもしれない。
      // 実際に予定が作られた回が十分あることを確かめておく。
      ok(casesWithEvents >= CASES * 0.7,
         CASES + ' 回中 ' + casesWithEvents + ' 回しか予定が作られていない');
      ok(totalEvents > CASES * 5, '作られた予定の総数が少なすぎる: ' + totalEvents);
    });
  });
}

module.exports = { registerPropertyTests };
