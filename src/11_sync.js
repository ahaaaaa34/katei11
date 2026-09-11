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

/** Google Calendar が受け取れる長さ。 */
const MAX_SUMMARY_CHARS = 1000;
const MAX_DESCRIPTION_CHARS = 8000;

function toCalendarResource_(event) {
  const timezone = CONFIG.timezone;
  const tier = eventTier_(event);
  const resource = {
    id: eventCalendarId_(event, timezone),
    // Google の上限は件名 1024 / 説明 8192 文字。入口でも切っているが、
    // ここが最後の防波堤。1件が長すぎるせいで同期ごと失敗させない。
    summary: clip_(renderTitle_(event), MAX_SUMMARY_CHARS),
    description: clip_(renderDescription_(event), MAX_DESCRIPTION_CHARS),
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
        indicator: event.indicatorId,
        impact: String(event.impact),
        source: event.source,
        confidence: event.confidence,
        // 次回の判断材料として、失いたくない中身を残しておく。
        // 情報源が一時的に落ちても、実測の時刻や発表された数値が
        // カレンダーから消えないようにするため。
        exact: event.exactTime ? '1' : '0',
        ts: event.timeSource,
        at: event.start.toISOString(),
        a: event.actual || '',
        f: event.forecast || '',
        p: event.previous || '',
      },
    },
  };

  if (event.allDay || CONFIG.display.allDay) {
    const day = localDate_(event.start, timezone);
    resource.start = { date: dateKey_(day) };
    resource.end = { date: dateKey_(addDays_(day, 1)) };
  } else {
    resource.start = { dateTime: event.start.toISOString(), timeZone: timezone };
    resource.end = { dateTime: event.end.toISOString(), timeZone: timezone };
  }

  const color = CONFIG.colors[tier];
  if (color) resource.colorId = String(color).trim();
  if (event.url && event.url.indexOf('http') === 0) {
    resource.source = { title: event.title.slice(0, 60), url: event.url };
  }

  resource.extendedProperties.private.hash = resourceContentHash_(resource);
  return resource;
}

/**
 * 実際にカレンダーへ書き込む内容そのもののハッシュ。
 *
 * イベントの生データではなく組み立て後の姿を見るのがだいじで、そうしないと
 * 表示設定（終日にする・絵文字をやめる等）を変えても「変化なし」と判定され、
 * 既存の予定が古い見た目のまま残り続ける。
 */
function resourceContentHash_(resource) {
  const payload = JSON.stringify([
    resource.summary, resource.description, resource.start, resource.end,
    resource.colorId || null, resource.reminders, resource.transparency,
    resource.source || null,
  ]);
  return sha1Hex_(payload).slice(0, 16);
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

/**
 * カレンダー上の予定が「表示日ベースで何日のものか」を返す。
 *
 * 同期のときに記録した uid（指標id@表示日）が正。無ければ開始時刻から求める。
 */
function resourceDisplayDate_(item) {
  const props = (item.extendedProperties && item.extendedProperties.private) || {};
  const uid = props.uid || '';
  const match = /@(\d{4}-\d{2}-\d{2})$/.exec(uid);
  if (match) return parseDateKey_(match[1]);
  if (item.start && item.start.date) return parseDateKey_(item.start.date);
  if (item.start && item.start.dateTime) {
    return localDate_(new Date(item.start.dateTime), CONFIG.timezone);
  }
  return null;
}

/**
 * すでにカレンダーにある中身を引き継ぐ。
 *
 * 情報源が一時的に落ちただけで、実測の発表時刻や、すでに出た結果の数値が
 * 消えてしまうのはおかしい。同じ発表（同じ予定 ID）について、前回書いた方が
 * 詳しいなら、その部分を引き継ぐ。
 * 今回の方が詳しければ今回が勝つので、値の更新は妨げない。
 */
function inheritFromExisting_(events, existing) {
  const byId = {};
  existing.forEach(function (item) { byId[item.id] = item; });

  return events.map(function (event) {
    const item = byId[eventCalendarId_(event, CONFIG.timezone)];
    if (!item) return event;
    const props = (item.extendedProperties && item.extendedProperties.private) || {};

    const patch = {};
    if (!event.actual && props.a) patch.actual = props.a;
    if (!event.forecast && props.f) patch.forecast = props.f;
    if (!event.previous && props.p) patch.previous = props.p;
    if (confidenceRank_(props.confidence) > confidenceRank_(event.confidence)) {
      // 同じ日付なので、根拠だけ引き継いでよい。
      patch.confidence = props.confidence;
    }
    // 時刻も、前回より出どころの確かなものが残っていれば引き継ぐ。
    // 発表機関の予定表が一時的に取れなかっただけで、カレンダーの時刻が
    // 暫定値に巻き戻る、ということを避ける。
    const storedTime = props.ts || (props.exact === '1' ? 'reported' : 'fallback');
    if (timeRank_(storedTime) > timeRank_(event.timeSource) && props.at) {
      const remembered = new Date(props.at);
      if (!isNaN(remembered.getTime())) {
        patch.timeSource = storedTime;
        patch.exactTime = true;
        patch.start = remembered;
        patch.end = new Date(remembered.getTime() + (event.end - event.start));
      }
    }
    if (!Object.keys(patch).length) return event;

    const merged = {};
    Object.keys(event).forEach(function (key) { merged[key] = event[key]; });
    Object.keys(patch).forEach(function (key) { merged[key] = patch[key]; });
    return merged;
  });
}

/**
 * すでにカレンダーにある、より確かな予定を「記憶」として使う。
 *
 * FRED が一時的に落ちただけで、公式の発表日で置いた予定が概算の日付に
 * 戻ってしまうと、利用者のカレンダー上で予定が行ったり来たりする。
 * 回線の不調で日付が動くようでは、そこに書いてある日付を信じられない。
 *
 * そこで、同じ指標の近い日付に、より確かな根拠の予定がすでにあるなら、
 * 今回の弱い予定は捨てて、あるものをそのまま残す。
 * 公式の日付が本当に変わったときは、新しい方も official なので置き換わる。
 */
function keepStrongerExisting_(events, existing) {
  const anchors = {};
  existing.forEach(function (item) {
    const props = (item.extendedProperties && item.extendedProperties.private) || {};
    if (!props.indicator || !props.confidence) return;
    const day = resourceDisplayDate_(item);
    if (!day) return;
    (anchors[props.indicator] = anchors[props.indicator] || []).push({
      id: item.id, day: day, rank: confidenceRank_(props.confidence),
    });
  });

  const keptIds = {};
  const replaced = [];
  const kept = events.filter(function (event) {
    const nearby = anchors[event.indicatorId];
    if (!nearby) return true;
    const day = localDate_(event.start, CONFIG.timezone);
    const mine = confidenceRank_(event.confidence);
    for (let i = 0; i < nearby.length; i++) {
      if (nearby[i].rank <= mine) continue;
      if (Math.abs(daysBetween_(day, nearby[i].day)) > SUPERSEDE_WINDOW_DAYS) continue;
      log_(event.indicatorId + ': より確かな予定が既にあるので、'
           + dateKey_(day) + ' の弱い予定は作りません');
      keptIds[nearby[i].id] = true;
      replaced.push(nearby[i].id);
      return false;
    }
    return true;
  });
  return { events: kept, keptIds: keptIds, replaced: replaced };
}

/**
 * カレンダーに保存してある予定を、表示用のイベントとして読み戻す。
 *
 * 週次まとめは「その週に何があるか」の一覧なので、今回計算したものではなく
 * **実際にカレンダーに入っているもの**から作らないと、情報源が揺れるたびに
 * まとめだけが書き換わる。差分計算には使わない（復元がわずかに違っても
 * 毎回更新が走ってしまうため、用途を表示に限る）。
 */
function eventFromResource_(item) {
  const props = (item.extendedProperties && item.extendedProperties.private) || {};
  const indicator = indicator_(props.indicator);
  const allDay = !!(item.start && item.start.date);
  const day = allDay ? parseDateKey_(item.start.date) : null;
  if (allDay && !day) return null;   // 日付として読めないものは触らない
  const start = allDay
    ? zonedTime_(day, '00:00', CONFIG.timezone)
    : new Date(item.start.dateTime);
  if (!validDate_(start)) return null;
  const end = allDay ? new Date(start.getTime() + 86400000)
                     : new Date(new Date(item.end.dateTime).getTime());

  return makeEvent_({
    indicatorId: props.indicator || 'unknown',
    title: indicator ? indicator.name : String(item.summary || '').replace(/^[^ ]+ /, ''),
    start: start,
    end: isNaN(end.getTime()) ? new Date(start.getTime() + 1800000) : end,
    impact: Number(props.impact) || (indicator ? indicator.impact : 0),
    country: indicator ? indicator.country : 'US',
    // 決算はカタログに無いが、カテゴリで絞っている人のために復元しておく。
    category: indicator ? indicator.category
      : (String(props.indicator || '').indexOf('earnings_') === 0 ? 'earnings' : 'other'),
    source: props.source || 'rules',
    confidence: props.confidence || 'estimated',
    allDay: allDay,
    // ts が無いのは、この項目を持つ前に書いた予定。exact から補う。
    timeSource: props.ts || (props.exact === '1' ? 'reported' : 'fallback'),
    actual: props.a || null,
    forecast: props.f || null,
    previous: props.p || null,
  });
}

/** 表示用に、「今回の予定 ＋ 据え置いた既存の予定」をそろえる。 */
function displayEvents_(events, existing) {
  const guarded = keepStrongerExisting_(inheritFromExisting_(events, existing), existing);
  const byId = {};
  existing.forEach(function (item) { byId[item.id] = item; });
  const restored = [];
  guarded.replaced.forEach(function (id) {
    const event = byId[id] ? eventFromResource_(byId[id]) : null;
    if (event) restored.push(event);
  });
  return guarded.events.concat(restored);
}

function buildPlan_(calendarId, events, existing, ctx) {
  const byId = {};
  existing.forEach(function (item) { byId[item.id] = item; });

  const plan = { calendarId: calendarId, created: [], updated: [], unchanged: [], deleted: [] };
  const guarded = keepStrongerExisting_(inheritFromExisting_(events, existing), existing);
  const seen = guarded.keptIds;
  events = guarded.events;

  events.forEach(function (event) {
    const resource = toCalendarResource_(event);
    seen[resource.id] = true;
    const current = byId[resource.id];
    if (!current) {
      plan.created.push({ event: event, resource: resource });
    } else if (storedHash_(current) === resource.extendedProperties.private.hash) {
      plan.unchanged.push(event);
    } else {
      plan.updated.push({ event: event, resource: resource });
    }
  });

  // この期間に前回書き込んだのに今回は選ばれなかったもの＝
  // 発表日が動いた、あるいはしきい値を上げた、のどちらか。
  //
  // ただし削除してよいのは、同期範囲の中の日付の予定だけ。
  // 日をまたぐ予定（23:45 開始など）は、範囲の外の日のものでも
  // 時間帯が重なるせいで一覧に出てくる。それを消すと、範囲から外れた
  // 過去の記録が「たまたま日付をまたいでいたから」という理由で消える。
  existing.forEach(function (item) {
    if (seen[item.id]) return;
    if (ctx && !inPruneRange_(item, ctx)) return;
    if (keepThroughOutage_(item)) return;
    plan.deleted.push(item);
  });
  return plan;
}

/**
 * その予定を、情報源が落ちているという理由だけで消さずに残すか。
 *
 * 「今回は出てこなかった」には2つの意味がある。本当に無くなった（発表日が
 * 動いた・しきい値を上げた）のと、その情報源に今回つながらなかっただけ、の
 * 2つ。後者で消すと、通信が不調な日だけカレンダーから決算や CPI が消えて
 * しまう。消してよいのは、その情報源がちゃんと動いた上で「もう無い」と
 * 言っているときだけ。
 *
 * ただし設定で対象外になったもの（しきい値を上げた・exclude に入れた）は、
 * 情報源の生死に関係なく整理する。人が明示的に外したものだから。
 */
function keepThroughOutage_(item) {
  const props = (item.extendedProperties && item.extendedProperties.private) || {};
  if (!sourceIsDown_(props.source)) return false;
  const restored = eventFromResource_(item);
  if (!restored) return true;   // 読み戻せないものは、判断がつくまで触らない
  return applyFilter_([restored]).length > 0;
}

function inPruneRange_(item, ctx) {
  const day = resourceDisplayDate_(item);
  if (!day) return true;   // 判定できないものは従来どおり整理対象にする
  return day.getTime() >= ctx.start.getTime() && day.getTime() <= ctx.end.getTime();
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
