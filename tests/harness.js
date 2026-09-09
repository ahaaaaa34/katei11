/**
 * GAS のソースを Node で読み込むための足場。
 *
 * Apps Script は全ファイルをひとつのスコープに連結して実行するので、
 * ここでも同じように連結してから評価する。こうしておくと「GAS では
 * 動くがテストでは動かない（逆も）」というズレが起きない。
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');

function sourceFiles() {
  return fs.readdirSync(SRC_DIR).filter((name) => name.endsWith('.js')).sort();
}

function readSource() {
  return sourceFiles()
    .map((name) => fs.readFileSync(path.join(SRC_DIR, name), 'utf8'))
    .join('\n');
}

/** トップレベルの宣言を拾って、テストから触れるようにする。 */
function exportedNames(source) {
  const names = new Set();
  const re = /^(?:function|const|let)\s+([A-Za-z_$][\w$]*)\s*[(=]/gm;
  let match;
  while ((match = re.exec(source)) !== null) names.add(match[1]);
  return [...names];
}

// ---------------------------------------------------------------------------
// GAS グローバルのスタブ
// ---------------------------------------------------------------------------

function makeStubs(overrides = {}) {
  // `overrides.X || 既定` にすると、X: undefined を渡して「その API が
  // 無い環境」を再現できない。キーの有無で判断する。
  const pick = (name, fallback) => (name in overrides ? overrides[name] : fallback);

  const store = Object.assign({}, overrides.properties);
  const sentMail = [];
  const fetched = [];
  const slept = [];

  const stubs = {
    // 真夜中を 24 時と返す古い ICU を再現するために差し替えられるようにしておく。
    Intl: pick('Intl', Intl),
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (key in store ? store[key] : null),
        setProperty: (key, value) => { store[key] = String(value); },
        deleteProperty: (key) => { delete store[key]; },
      }),
    },
    Logger: { log: overrides.log || (() => {}) },
    UrlFetchApp: pick('UrlFetchApp', {
      fetch: (url, params) => {
        fetched.push({ url, params });
        throw new Error('テストではネットワークを使いません: ' + url);
      },
      fetchAll: (requests) => {
        requests.forEach((r) => fetched.push(r));
        throw new Error('テストではネットワークを使いません');
      },
    }),
    Calendar: pick('Calendar', fakeCalendar()),
    ScriptApp: pick('ScriptApp', fakeScriptApp()),
    MailApp: { sendEmail: (to, subject, body) => sentMail.push({ to, subject, body }) },
    LockService: pick('LockService', {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
    }),
    Session: { getEffectiveUser: () => ({ getEmail: () => 'test@example.com' }) },
    Utilities: {
      // Intl が使える環境ではこちらは呼ばれない。保険経路の形だけ用意する。
      formatDate: () => { throw new Error('Utilities.formatDate は使われていません'); },
      // 再試行の待ち時間はテストでは記録するだけで、実際には待たない。
      sleep: (ms) => { slept.push(ms); },
    },
  };
  return { stubs, store, sentMail, fetched, slept };
}

/**
 * Calendar API v3（拡張サービス）の偽物。
 *
 * events.list は **実 API と同じく timeMin/timeMax を尊重する**。
 * ここを手抜きして全件返していたせいで、「窓の端のイベントが一覧に出ず、
 * 毎回作り直される」というバグをテストが素通りさせていた。
 */
function fakeCalendar(seed = {}) {
  const events = new Map(Object.entries(seed.events || {}));
  const calendars = (seed.calendarList || []).slice();
  const calls = [];
  let nextCalendarId = 1;

  const api = {
    calls,
    events,
    calendars,
    failInsertOnce: seed.failInsertOnce || null,   // 409 を1回だけ返す ID
    missingOnRemove: new Set(seed.missingOnRemove || []),

    CalendarList: {
      list: (opts) => {
        calls.push(['calendarList.list', opts]);
        return { items: calendars };
      },
    },
    Calendars: {
      insert: (resource) => {
        calls.push(['calendars.insert', resource]);
        const created = Object.assign({ id: 'created-' + nextCalendarId++ }, resource);
        calendars.push(created);
        return created;
      },
    },
    Events: {
      list: (calendarId, opts) => {
        calls.push(['events.list', opts]);
        const min = opts.timeMin ? new Date(opts.timeMin).getTime() : -Infinity;
        const max = opts.timeMax ? new Date(opts.timeMax).getTime() : Infinity;
        const items = [...events.values()].filter((item) => {
          const props = (item.extendedProperties && item.extendedProperties.private) || {};
          if (props.ecal !== '1') return false;
          // 実 API と同じ交差判定（start < timeMax かつ end > timeMin）
          const span = eventSpan(item);
          return span.start < max && span.end > min;
        });
        return { items };
      },
      insert: (resource, calendarId) => {
        calls.push(['events.insert', resource.id]);
        if (api.failInsertOnce === resource.id) {
          api.failInsertOnce = null;
          const err = new Error('API call to calendar.events.insert failed: duplicate');
          throw err;
        }
        events.set(resource.id, resource);
        return resource;
      },
      update: (resource, calendarId, eventId) => {
        calls.push(['events.update', eventId]);
        events.set(eventId, resource);
        return resource;
      },
      remove: (calendarId, eventId) => {
        calls.push(['events.remove', eventId]);
        if (api.missingOnRemove.has(eventId)) {
          throw new Error('API call to calendar.events.delete failed: Not Found');
        }
        events.delete(eventId);
      },
    },
  };
  return api;
}

/** 予定リソースから絶対時刻の範囲を取り出す（終日は日付だけを持つ）。 */
function eventSpan(item) {
  const parse = (side, fallbackHour) => {
    if (side.dateTime) return new Date(side.dateTime).getTime();
    // 終日イベントは表示タイムゾーンの深夜。テストは Asia/Tokyo 前提。
    return new Date(side.date + 'T' + fallbackHour + ':00+09:00').getTime();
  };
  return { start: parse(item.start, '00:00'), end: parse(item.end, '00:00') };
}

function fakeScriptApp() {
  let triggers = [];
  return {
    getProjectTriggers: () => triggers,
    deleteTrigger: (trigger) => { triggers = triggers.filter((t) => t !== trigger); },
    newTrigger: (handler) => {
      const spec = { handler, hour: null };
      const builder = {
        timeBased: () => builder,
        everyDays: () => builder,
        atHour: (hour) => { spec.hour = hour; return builder; },
        create: () => {
          triggers.push({ getHandlerFunction: () => handler, spec });
          return spec;
        },
      };
      return builder;
    },
    _triggers: () => triggers,
  };
}

/** ソースを読み込み、宣言済みシンボルを詰めたオブジェクトを返す。 */
function loadGas(overrides = {}) {
  const source = readSource();
  const { stubs, store, sentMail, fetched, slept } = makeStubs(overrides);
  const names = Object.keys(stubs);
  const exportList = exportedNames(source).join(', ');
  const factory = new Function(...names, `${source}\nreturn { ${exportList} };`);
  const api = factory(...names.map((name) => stubs[name]));
  return Object.assign(api, {
    _stubs: stubs, _store: store, _mail: sentMail, _fetched: fetched, _slept: slept,
  });
}

module.exports = { loadGas, fakeCalendar, fakeScriptApp, sourceFiles, readSource };
