/**
 * カレンダーとの差分計算と反映。
 *
 * 拡張サービスの Calendar API（v3）を使う。CalendarApp ではなく v3 なのは、
 * 予定 ID を自分で決められるから。ID を「指標 id + 表示日」のハッシュに
 * しておけば、何度実行しても同じ予定を上書きするだけで重複しない。
 */

const MAX_REMINDERS = 5;   // Google 側の上限

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

  const cached = prop_(PROP_CALENDAR_ID);
  if (cached) return cached;

  const name = CONFIG.calendar.name;
  let pageToken = null;
  do {
    const page = Calendar.CalendarList.list({ maxResults: 250, pageToken: pageToken });
    const items = page.items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].summary === name) {
        props_().setProperty(PROP_CALENDAR_ID, items[i].id);
        return items[i].id;
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  if (create === false) {
    throw new Error('カレンダー「' + name + '」が見つかりません');
  }

  log_('カレンダー「' + name + '」を作成します');
  const created = Calendar.Calendars.insert({
    summary: name,
    description: CONFIG.calendar.description || '',
    timeZone: CONFIG.timezone,
  });
  props_().setProperty(PROP_CALENDAR_ID, created.id);
  return created.id;
}

/** このツールが作った予定だけを列挙する。 */
function listManagedEvents_(calendarId, start, end) {
  const out = [];
  let pageToken = null;
  do {
    const page = Calendar.Events.list(calendarId, {
      timeMin: zonedTime_(start, '00:00', CONFIG.timezone).toISOString(),
      timeMax: zonedTime_(addDays_(end, 1), '00:00', CONFIG.timezone).toISOString(),
      singleEvents: true,
      showDeleted: false,
      maxResults: 2500,
      privateExtendedProperty: MANAGED_KEY + '=' + MANAGED_VALUE,
      pageToken: pageToken,
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
      Calendar.Events.insert(row.resource, plan.calendarId);
    } catch (err) {
      // ID が既にある（期間外にあった、削除済みで残っていた等）場合は
      // 作り直さず更新して ID を使い回す。
      if (isDuplicateIdError_(err)) {
        Calendar.Events.update(row.resource, plan.calendarId, row.resource.id);
      } else {
        throw err;
      }
    }
  });

  plan.updated.forEach(function (row) {
    Calendar.Events.update(row.resource, plan.calendarId, row.resource.id);
  });

  plan.deleted.forEach(function (item) {
    try {
      Calendar.Events.remove(plan.calendarId, item.id);
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
