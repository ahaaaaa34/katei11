/**
 * カレンダーとの差分計算と反映。
 *
 * 拡張サービスの Calendar API（v3）を使う。CalendarApp ではなく v3 なのは、
 * 予定 ID を自分で決められるから。ID を「指標 id + 表示日」のハッシュに
 * しておけば、何度実行しても同じ予定を上書きするだけで重複しない。
 */

const MAX_REMINDERS = 5;   // Google 側の上限

/** 一時的な失敗を何回まで待って試し直すか。 */
const CALENDAR_RETRIES = 4;

/**
 * カレンダー API をひとつ呼ぶ。
 *
 * 初回同期では 60〜130 件をまとめて書き込むので、レート制限や
 * 一時的なバックエンドエラーに当たることがある。そこで落として同期全体を
 * 失敗させると、その日のカレンダーが丸ごと古いままになるため、
 * 待って試し直す。恒久的な失敗（権限不足、ID 重複など）はそのまま投げる。
 */
function calendarCall_(action) {
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (err) {
      if (attempt >= CALENDAR_RETRIES || !isRetriableError_(err)) throw err;
      log_('カレンダー API が一時的に失敗（' + attempt + '回目）。'
           + (delay / 1000) + '秒待って試し直します。');
      sleep_(delay);
      delay *= 2;
    }
  }
}

function isRetriableError_(err) {
  const text = String(err && err.message ? err.message : err);
  return /rate limit|rateLimit|quota|backend error|internal error|try again|timed? ?out|\b(429|500|502|503|504)\b/i
    .test(text);
}

function sleep_(ms) {
  try {
    Utilities.sleep(ms);
  } catch (err) {
    // テスト環境などで sleep が無くても、再試行そのものは続ける。
  }
}

function toCalendarResource_(event) {
  const timezone = CONFIG.timezone;
  const tier = eventTier_(event);
  const resource = {
    id: eventCalendarId_(event, timezone),
    summary: renderTitle_(event),
    description: renderDescription_(event),
    // 指標は「予定」ではないので、空き時間検索の邪魔をしないようにする。
    transparency: 'transparent',
    reminders: {
      useDefault: false,
      overrides: (CONFIG.reminders[tier] || []).slice(0, MAX_REMINDERS).map(function (minutes) {
        return { method: 'popup', minutes: minutes };
      }),
    },
    extendedProperties: {
      private: {
        ecal: MANAGED_VALUE,
        uid: eventUid_(event, timezone),
        hash: eventContentHash_(event),
        indicator: event.indicatorId,
        impact: String(event.impact),
        source: event.source,
      },
    },
  };

  if (event.allDay) {
    const day = localDate_(event.start, timezone);
    resource.start = { date: dateKey_(day) };
    resource.end = { date: dateKey_(addDays_(day, 1)) };
  } else {
    resource.start = { dateTime: event.start.toISOString(), timeZone: timezone };
    resource.end = { dateTime: event.end.toISOString(), timeZone: timezone };
  }

  const color = CONFIG.colors[tier];
  if (color) resource.colorId = String(color);
  if (event.url && event.url.indexOf('http') === 0) {
    resource.source = { title: event.title.slice(0, 60), url: event.url };
  }
  return resource;
}

// ---------------------------------------------------------------------------
// カレンダーの解決
// ---------------------------------------------------------------------------

function resolveCalendarId_(create) {
  if (CONFIG.calendar.id) return CONFIG.calendar.id;

  const name = CONFIG.calendar.name;
  // 名前を変えたのに古いカレンダーへ書き続けないよう、
  // キャッシュは「そのとき探した名前」とセットで持つ。
  const cached = prop_(PROP_CALENDAR_ID);
  if (cached && prop_(PROP_CALENDAR_NAME) === name) return cached;
  if (cached) forgetCalendarId_();

  let pageToken = null;
  do {
    const page = calendarCall_(function () {
      return Calendar.CalendarList.list({ maxResults: 250, pageToken: pageToken });
    });
    const items = page.items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].summary === name) {
        rememberCalendarId_(items[i].id, name);
        return items[i].id;
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  if (create === false) {
    throw new Error('カレンダー「' + name + '」が見つかりません');
  }

  log_('カレンダー「' + name + '」を作成します');
  const created = calendarCall_(function () {
    return Calendar.Calendars.insert({
      summary: name,
      description: CONFIG.calendar.description || '',
      timeZone: CONFIG.timezone,
    });
  });
  rememberCalendarId_(created.id, name);
  return created.id;
}

function rememberCalendarId_(id, name) {
  try {
    props_().setProperty(PROP_CALENDAR_ID, id);
    props_().setProperty(PROP_CALENDAR_NAME, name);
  } catch (err) {
    log_('カレンダー ID を保存できませんでした（動作には影響しません）: ' + err);
  }
}

function forgetCalendarId_() {
  try {
    props_().deleteProperty(PROP_CALENDAR_ID);
    props_().deleteProperty(PROP_CALENDAR_NAME);
  } catch (err) {
    log_('カレンダー ID を消せませんでした: ' + err);
  }
}

/**
 * 覚えていたカレンダーが消されていた場合に、一度だけ探し直して やり直す。
 * これが無いと、カレンダーを削除した瞬間から毎日失敗し続ける。
 */
function withCalendarRecovery_(action) {
  try {
    return action();
  } catch (err) {
    if (!isMissingError_(err) || !prop_(PROP_CALENDAR_ID)) throw err;
    log_('覚えていたカレンダーが見つかりません。探し直します。');
    forgetCalendarId_();
    return action();
  }
}

/** このツールが作った予定だけを列挙する。 */
function listManagedEvents_(calendarId, start, end) {
  const out = [];
  let pageToken = null;
  do {
    const page = calendarCall_(function () {
      return Calendar.Events.list(calendarId, {
        timeMin: zonedTime_(start, '00:00', CONFIG.timezone).toISOString(),
        timeMax: zonedTime_(addDays_(end, 1), '00:00', CONFIG.timezone).toISOString(),
        singleEvents: true,
        showDeleted: false,
        maxResults: 2500,
        privateExtendedProperty: MANAGED_KEY + '=' + MANAGED_VALUE,
        pageToken: pageToken,
      });
    });
    (page.items || []).forEach(function (item) { if (item.id) out.push(item); });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

// ---------------------------------------------------------------------------
// 差分
// ---------------------------------------------------------------------------

function buildPlan_(calendarId, events, existing) {
  const byId = {};
  existing.forEach(function (item) { byId[item.id] = item; });

  const plan = { calendarId: calendarId, created: [], updated: [], unchanged: [], deleted: [] };
  const seen = {};

  events.forEach(function (event) {
    const resource = toCalendarResource_(event);
    seen[resource.id] = true;
    const current = byId[resource.id];
    if (!current) {
      plan.created.push({ event: event, resource: resource });
    } else if (storedHash_(current) === eventContentHash_(event)) {
      plan.unchanged.push(event);
    } else {
      plan.updated.push({ event: event, resource: resource });
    }
  });

  // この期間に前回書き込んだのに今回は選ばれなかったもの＝
  // 発表日が動いた、あるいはしきい値を上げた、のどちらか。
  existing.forEach(function (item) {
    if (!seen[item.id]) plan.deleted.push(item);
  });
  return plan;
}

function storedHash_(item) {
  const props = (item.extendedProperties && item.extendedProperties.private) || {};
  return props.hash || null;
}

function planSummary_(plan) {
  return '新規 ' + plan.created.length + ' / 更新 ' + plan.updated.length
       + ' / 削除 ' + plan.deleted.length + ' / 変更なし ' + plan.unchanged.length;
}

function planChanges_(plan) {
  return plan.created.length + plan.updated.length + plan.deleted.length;
}

// ---------------------------------------------------------------------------
// 反映
// ---------------------------------------------------------------------------

function applyPlan_(plan) {
  plan.created.forEach(function (row) {
    try {
      calendarCall_(function () {
        return Calendar.Events.insert(row.resource, plan.calendarId);
      });
    } catch (err) {
      // ID が既にある（期間外にあった、削除済みで残っていた等）場合は
      // 作り直さず更新して ID を使い回す。
      if (!isDuplicateIdError_(err)) throw err;
      calendarCall_(function () {
        return Calendar.Events.update(row.resource, plan.calendarId, row.resource.id);
      });
    }
  });

  plan.updated.forEach(function (row) {
    calendarCall_(function () {
      return Calendar.Events.update(row.resource, plan.calendarId, row.resource.id);
    });
  });

  plan.deleted.forEach(function (item) {
    try {
      calendarCall_(function () { return Calendar.Events.remove(plan.calendarId, item.id); });
    } catch (err) {
      if (!isMissingError_(err)) throw err;   // 既に無いなら成功と同じ
    }
  });

  log_('同期完了: ' + planSummary_(plan));
  return plan;
}

function isDuplicateIdError_(err) {
  const text = String(err && err.message ? err.message : err);
  return /duplicate|already exists|409/i.test(text);
}

function isMissingError_(err) {
  const text = String(err && err.message ? err.message : err);
  return /not found|deleted|404|410|Resource has been deleted/i.test(text);
}
