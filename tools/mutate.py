#!/usr/bin/env python3
"""変異テスト：修正を一時的に巻き戻し、回帰テストが本当に落ちるかを見る。

テストが通ることは、そのテストが意味を持つことを保証しない。
バグを入れ直して落ちなければ、そのテストは何も守っていない。
"""

import atexit
import re
import signal
import os
import subprocess
import sys

MUTATIONS = [
    ("窓の判定を米東部日付に戻す", "src/06_providers.js",
     "      const start = zonedTime_(date, indicator.time, indicatorTimezone_(indicator));\n"
     "      if (!inDisplayWindow_(start, ctx)) return;",
     "      if (date.getTime() < ctx.start.getTime() || date.getTime() > ctx.end.getTime()) return;\n"
     "      const start = zonedTime_(date, indicator.time, indicatorTimezone_(indicator));"),
    ("書き込みの再試行をやめる", "src/11_sync.js",
     "      if (attempt >= CALENDAR_RETRIES || !isRetriableError_(err)) throw err;",
     "      if (true) throw err;"),
    ("カレンダー消失からの復旧をやめる", "src/14_main.js",
     "    const plan = withCalendarRecovery_(function () {",
     "    const plan = (function () {"),
    ("日銀の発表時刻を 23:00 に戻す", "src/01_indicators.js",
     '    time: "12:00",\n    duration: 90,', '    time: "23:00",\n    duration: 90,'),
    ("ECB を米東部時間に固定し直す", "src/01_indicators.js",
     '    time: "14:15",\n    tz: "Europe/Berlin",', '    time: "08:15",'),
    ("同名カレンダーを見つけた順に採る", "src/11_sync.js",
     "    matches.sort();", ""),
    ("同名カレンダーが複数あっても黙っている", "src/11_sync.js",
     "    if (matches.length > 1) {", "    if (false) {"),
    ("カレンダー名の確認をやめる", "src/11_sync.js",
     "  if (cached && prop_(PROP_CALENDAR_NAME) === name) return cached;",
     "  if (cached) return cached;"),
    ("実行内メモをやめる", "src/08_fomc_auto.js",
     "  if (FOMC_AUTO_MEMO_) return FOMC_AUTO_MEMO_;", ""),
    ("しきい値の既定値をやめる", "src/09_collect.js",
     "  const minImpact = typeof filter.minImpact === 'number' ? filter.minImpact : 55;",
     "  const minImpact = filter.minImpact;"),
    ("決算の取得範囲を狭める", "src/07_providers_net.js",
     "  const from = addDays_(ctx.start, -1);\n  const to = addDays_(ctx.end, 1);",
     "  const from = ctx.start;\n  const to = ctx.end;"),
    ("存在しない時刻を後ろへ送る", "src/04_schedule.js",
     "    if (candidate > forward) forward = candidate;",
     "    if (candidate < forward) forward = candidate;"),
    ("二度ある時刻で、遅い方を採る", "src/04_schedule.js",
     "    valid.forEach(function (ms) { if (ms < earliest) earliest = ms; });",
     "    valid.forEach(function (ms) { if (ms > earliest) earliest = ms; });"),
    ("置いた先でずれを確かめない", "src/04_schedule.js",
     "    if (tzOffsetMinutes_(new Date(candidate), timezone) === minutes) valid.push(candidate);",
     "    valid.push(candidate);"),
    ("切替の前後を見ずに、その場のずれだけで決める", "src/04_schedule.js",
     "  [-14 * 3600000, 0, 14 * 3600000].forEach(function (shift) {",
     "  [0].forEach(function (shift) {"),
    ("「何日ごろ」を営業日に寄せない", "src/04_schedule.js",
     "  const forward = nextBusinessDay_(ymd_(year, month, day));\n"
     "  if (forward.getUTCMonth() + 1 === month) return forward;",
     "  return ymd_(year, month, day);\n"
     "  // lint-ok: 変異テスト用（到達しない）\n"
     "  const forward = nextBusinessDay_(ymd_(year, month, day));\n"
     "  if (forward.getUTCMonth() + 1 === month) return forward;"),
    ("読めない日付を Date として通す", "src/05_catalog.js",
     "  return value instanceof Date && !isNaN(value.getTime());",
     "  return value instanceof Date;"),
    ("書き込む姿ではなく、生の中身でハッシュを取る", "src/11_sync.js",
     "function resourceContentHash_(resource) {\n"
     "  const payload = JSON.stringify([\n"
     "    resource.summary, resource.description, resource.start, resource.end,\n"
     "    resource.colorId || null, resource.reminders, resource.transparency,\n"
     "    resource.source || null,\n"
     "  ]);",
     "function resourceContentHash_(resource) {\n"
     "  const payload = JSON.stringify([resource.start, resource.end]);"),
    ("形の崩れた予定で同期ごと落ちる", "src/11_sync.js",
     "    : new Date((item.start && item.start.dateTime) || NaN);",
     "    : new Date(item.start.dateTime);"),
    ("死んだ発表元リンクを数えない", "src/14_main.js",
     "      bad++;\n      seen[indicator.url] = '❌';", "      seen[indicator.url] = '❌';"),
    ("同じ発表元リンクを何度も叩く", "src/14_main.js",
     "    if (seen[indicator.url]) {", "    if (false) {"),
    ("真夜中の時の正規化をやめる", "src/04_schedule.js",
     "  out.hour = out.hour % 24;\n", ""),
    ("設定の検証をやめる", "src/14_main.js",
     "    validateConfig_();\n    requireCalendarService_();",
     "    requireCalendarService_();"),
    ("同期範囲の上限をやめる", "src/09_collect.js",
     "  if (value > MAX_WINDOW_DAYS) {", "  if (false) {"),
    ("多重実行の排他をやめる", "src/14_main.js",
     "  const lock = acquireLock_();\n  if (!lock) {",
     "  const lock = acquireLock_();\n  if (false) {"),
    ("FOMC 日程の妥当性検査をやめる", "src/08_fomc_auto.js",
     "    if (problem) {", "    if (false) {"),
    ("手入力の会合日程を照合せず捨てる", "src/08_fomc_auto.js",
     "  return reconcileFomc_(curated, autoFomcMeetings_(curated));",
     "  return reconcileFomc_([], autoFomcMeetings_(curated));"),
    ("目に見えない文字をそのまま通す", "src/05_catalog.js",
     "  const s = sanitizeText_(String(text));", "  const s = String(text);"),
    ("通知の範囲を確かめずに送る", "src/11_sync.js",
     "    if (rounded < 0 || rounded > MAX_REMINDER_MINUTES) return;", ""),
    ("通知の件数を絞らずに送る", "src/11_sync.js",
     "    if (out.length >= MAX_REMINDERS) return;", ""),
    ("通知の小数を設定の検証で見逃す", "src/14_main.js",
     "          || minutes < 0 || minutes > 40320 || minutes !== Math.floor(minutes)) {",
     "          || minutes < 0 || minutes > 40320) {"),
    ("実体参照を戻さない", "src/07_providers_net.js",
     "  return decodeEntities_(String(html).replace(/<[^>]*>/g, ' '))",
     "  return String(html).replace(/<[^>]*>/g, ' ')"),
    ("実体参照を二重に戻す", "src/07_providers_net.js",
     "  return decodeEntities_(String(html).replace(/<[^>]*>/g, ' '))",
     "  return decodeEntities_(decodeEntities_(String(html).replace(/<[^>]*>/g, ' ')))"),
    ("知らない実体参照を空にする", "src/07_providers_net.js",
     "      return hasKey_(ENTITIES, key) ? ENTITIES[key] : whole;",
     "      return lookup_(ENTITIES, key, '');"),
    ("範囲外の符号位置をそのまま作る", "src/07_providers_net.js",
     "      return isFinite(code) && code > 0 && code <= 0x10ffff\n"
     "        ? String.fromCodePoint(code) : '';\n"
     "    })\n"
     "    // & を最後に戻す",
     "      return String.fromCodePoint(code % 0x10ffff);\n"
     "    })\n"
     "    // & を最後に戻す"),
    ("値の形を確かめずに受け取る", "src/05_catalog.js",
     "  return FIGURE_SHAPE.test(value) ? value : null;", "  return value;"),
    ("リンク先を素で繋ぐ", "src/07_providers_net.js",
     "    const safePath = href && /^\\/(?!\\/)[\\w\\-./?=&%#]*$/.test(href[1]) ? href[1] : null;",
     "    const safePath = href ? href[1] : null;"),
    ("同じ指標の埋め尽くしを許す", "src/09_collect.js",
     "    found = dropImplausibleFloods_(found, provider.name);", ""),
    ("埋め尽くしを、日付でなく件数で数える", "src/09_collect.js",
     "    const count = Object.keys(dates).length;", "    const count = group.length;"),
    ("SQ を第3金曜に固定する", "src/06_providers.js",
     "    const thirdFriday = expiryDay_(year, month);",
     "    const thirdFriday = nthWeekday_(year, month, WEEKDAY_NUM.fri, 3);"),
    ("据え置きの相手を最初に見つけたもので決める", "src/11_sync.js",
     "      if (!best || gap < best.gap) best = { gap: gap, anchor: nearby[i] };",
     "      if (!best) best = { gap: gap, anchor: nearby[i] };"),
    ("据え置きの控えを重複させる", "src/11_sync.js",
     "    if (!keptIds[best.anchor.id]) {\n"
     "      keptIds[best.anchor.id] = true;\n"
     "      replaced.push(best.anchor.id);   // 同じものを二度並べない\n"
     "    }",
     "    keptIds[best.anchor.id] = true;\n"
     "    replaced.push(best.anchor.id);"),
    ("通知の控えの保存で例外を漏らす", "src/13_health.js",
     "  try {\n"
     "    props_().setProperty(PROP_LAST_MAINTENANCE_MAIL, signature + '|' + Date.now());\n"
     "  } catch (err) {\n"
     "    log_('通知の控えを保存できませんでした（次回また届きます）: ' + err);\n"
     "  }",
     "  props_().setProperty(PROP_LAST_MAINTENANCE_MAIL, signature + '|' + Date.now());"),
    ("確認先が無くても undefined と書く", "src/13_health.js",
     "    const where = section.verify_url\n"
     "      ? section.verify_url + ' を見て'\n"
     "      : '中央銀行の公式ページを見て';",
     "    const where = section.verify_url + ' を見て';"),
    ("週次まとめを送った週を控えない", "src/14_main.js",
     "  if (prop_(PROP_LAST_DIGEST_WEEK) === thisWeek) return false;", ""),
    ("設定が壊れていたら showStatus を落とす", "src/14_main.js",
     "function showStatus() {\n"
     "  const problems = configProblems_();\n"
     "  if (problems.length) {",
     "function showStatus() {\n"
     "  const problems = [];\n"
     "  if (problems.length) {"),
    ("カレンダー側の書き換えに気づかない", "src/11_sync.js",
     "    } else if (matchesCalendar_(current, resource)) {",
     "    } else if (storedHash_(current) === resource.extendedProperties.private.hash) {"),
    ("開始時刻を文字列でくらべる", "src/11_sync.js",
     "  const at = new Date(left.dateTime || 0).getTime();\n"
     "  const bt = new Date(right.dateTime || 0).getTime();\n"
     "  return !isNaN(at) && !isNaN(bt) && at === bt;",
     "  return left.dateTime === right.dateTime;"),
    ("日程の検査で、読めない日付を黙って通す", "src/08_fomc_auto.js",
     "    if (!date) return '日付として読めない: ' + key;", "    if (!date) return;"),
    ("翌年から落ちてくる振替休日を数えない", "src/04_schedule.js",
     "  const nextNewYear = observed_(ymd_(year + 1, 1, 1));\n"
     "  if (nextNewYear.getUTCFullYear() === year) out[dateKey_(nextNewYear)] = '元日（振替）';",
     ""),
    ("振替で前年に落ちた元日も、その年の表に残す", "src/04_schedule.js",
     "  if (newYear.getUTCFullYear() === year) out[dateKey_(newYear)] = '元日';",
     "  out[dateKey_(newYear)] = '元日';"),
    ("型の名前にプロトタイプの鍵を通す", "src/03_util.js",
     "  return !!table && typeof name === 'string'\n"
     "      && Object.prototype.hasOwnProperty.call(table, name);",
     "  return !!table[name];"),
    ("外から来た文字列を切らない", "src/05_catalog.js",
     "  return s.length <= limit ? s : s.slice(0, limit - 1) + '…';", "  return s;"),
    ("組み立てた予定の長さを見ない", "src/11_sync.js",
     "    summary: clip_(renderTitle_(event), MAX_SUMMARY_CHARS),\n"
     "    description: clip_(renderDescription_(event), MAX_DESCRIPTION_CHARS),",
     "    summary: renderTitle_(event),\n"
     "    description: renderDescription_(event),"),
    ("読めない日時のまま予定を作る", "src/05_catalog.js",
     "  if (!validDate_(event.start) || !validDate_(event.end)) {",
     "  if (!(event.start instanceof Date) || !(event.end instanceof Date)) {"),
    ("壊れた日付をそのまま日付にする", "src/04_schedule.js",
     "  const match = /^(\\d{4})-(\\d{1,2})-(\\d{1,2})$/.exec(String(text).slice(0, 10));\n"
     "  if (!match) return null;",
     "  const match = (/^(\\d{4})-(\\d{1,2})-(\\d{1,2})$/.exec(String(text).slice(0, 10))\n"
     "    || [0, String(text).slice(0, 4), '1', '1']);\n"
     "  if (!match) return null;"),
    ("FRED の壊れた日付の行も採る", "src/07_providers_net.js",
     "    if (!day) return;   // 読めない日付の行は飛ばす（そこだけ捨てる）", ""),
    ("FRED の応答が配列かを見ない", "src/07_providers_net.js",
     "    const page = Array.isArray(payload.release_dates) ? payload.release_dates : [];",
     "    const page = payload.release_dates || [];"),
    ("予定表の行数を打ち切らない", "src/07_providers_net.js",
     "    if (rows.length >= SCHEDULE_MAX_ROWS) {", "    if (false) {"),
    ("発表予定表を読まない", "src/09_collect.js",
     "  if (CONFIG.providers.officialTimes) {\n"
     "    providers.push({ name: 'official', run: providerOfficial_ });\n"
     "  }", ""),
    ("予定表の時刻より暫定値を優先する", "src/05_catalog.js",
     "  if (timeRank_(low.timeSource) > timeRank_(merged.timeSource)) {",
     "  if (false) {"),
    ("読めない予定表も中途半端に採る", "src/07_providers_net.js",
     "    if (parsed.length < SCHEDULE_MIN_ROWS) {", "    if (false) {"),
    ("ありえない時刻もそのまま採る", "src/07_providers_net.js",
     "  if (hour < SCHEDULE_MIN_HOUR || hour > SCHEDULE_MAX_HOUR) return null;", ""),
    ("表からかけ離れた年も採る", "src/07_providers_net.js",
     "  if (Math.abs(year - defaultYear) > 1) return null;", ""),
    ("日付は欄の先頭でなくても拾う（ISO）", "src/07_providers_net.js",
     "  let match = /^(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b/.exec(s);",
     "  let match = /(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b/.exec(s);"),
    ("日付は欄の先頭でなくても拾う（月名）", "src/07_providers_net.js",
     "  match = /^([A-Za-z]{3,9})\\.?\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?\\b/.exec(s);",
     "  match = /([A-Za-z]{3,9})\\.?\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?\\b/.exec(s);"),
    ("日付は欄の先頭でなくても拾う（スラッシュ）", "src/07_providers_net.js",
     "  match = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{2,4})\\b/.exec(s);",
     "  match = /(\\d{1,2})\\/(\\d{1,2})\\/(\\d{2,4})\\b/.exec(s);"),
    ("対象期間を落とさずに名寄せする", "src/07_providers_net.js",
     "  const plain = scheduleReleaseName_(name);", "  const plain = name;"),
    ("暫定値を暫定値と書かない", "src/10_render.js",
     "  return '（発表時刻は未確認の暫定値）';", "  return '';"),
    ("時刻の出どころを保存しない", "src/11_sync.js",
     "        ts: event.timeSource,", ""),
    ("週次まとめも指標と同じ本文にする", "src/10_render.js",
     "  if (isDigest_(event)) return renderDigestDescription_(event);", ""),
    ("週次まとめの根拠を指定し忘れる", "src/12_digest.js",
     "      confidence: 'rule',", ""),
    ("未確定の断り書きを一種類にする", "src/10_render.js",
     "  if (hasRule) {\n"
     "    return 'この日付は過去の慣例から推定したものです。公式発表で前後する可能性があります。';\n"
     "  }",
     "  return 'この日付は過去の慣例から推定したものです。公式発表で前後する可能性があります。';\n"
     "  if (hasRule) {}"),
    ("名寄せで国を見ない", "src/07_providers_net.js",
     "    const indicator = matchEventName_(row.name, localDate_(start, ctx.timezone),\n"
     "                                      row.country);",
     "    const indicator = matchEventName_(row.name, localDate_(start, ctx.timezone));"),
    ("他国の指標にも当てる", "src/05_catalog.js",
     "  if (!pool.length) return null;", "  if (!pool.length) return hits[0].indicator;"),
    ("名寄せで具体性を見ない", "src/05_catalog.js",
     "  const specific = pool.filter(function (hit) { return hit.length === widest; });",
     "  const specific = pool;"),
    ("通貨の欄を読まない", "src/07_providers_net.js",
     "      country: investingCountry_(body),", "      country: null,"),
    ("発表のまとめを表示日だけで行う", "src/09_collect.js",
     "  const byRelease = groupMerge_(events, function (event) {\n"
     "    return releaseKey_(event, timezone);\n"
     "  });\n"
     "  return groupMerge_(byRelease, function (event) {",
     "  const byRelease = events;\n"
     "  return groupMerge_(byRelease, function (event) {"),
    ("終日の予定も地元の日付でまとめる", "src/09_collect.js",
     "  if (event.allDay) return eventUid_(event, timezone);", ""),
    ("情報源が落ちていても予定を消す", "src/11_sync.js",
     "    if (keepThroughOutage_(item)) return;", ""),
    ("落ちた情報源を控えない", "src/09_collect.js",
     "  SOURCE_DOWN_[name] = why || '取得できませんでした';", ""),
    ("設定で外れた予定も情報源の生死で残す", "src/11_sync.js",
     "  if (!restored) return true;   // 読み戻せないものは、判断がつくまで触らない\n"
     "  return applyFilter_([restored]).length > 0;",
     "  if (!restored) return true;\n"
     "  return true;"),
    ("設定で外れた記録も、済んだからと残す", "src/11_sync.js",
     "  if (!restored) return true;\n"
     "  return applyFilter_([restored]).length > 0;\n}\n\n"
     "/** 予定の開始時刻をミリ秒で返す（読めなければ null）。 */",
     "  if (!restored) return true;\n"
     "  return true;\n}\n\n"
     "/** 予定の開始時刻をミリ秒で返す（読めなければ null）。 */"),
    ("済んだ記録を、情報源から消えたら消す", "src/11_sync.js",
     "    if (isFinishedRecord_(item)) return;", ""),
    ("まだ先の予定まで記録として守る", "src/11_sync.js",
     "  if (at === null || at >= Date.now()) return false;   // まだ先のことは対象外",
     "  if (at === null) return false;"),
    ("FRED の対応付けの重なりを見ない", "src/14_main.js",
     "  problems.push.apply(problems, fredReleaseOverlaps_());", ""),
    ("拡張サービスの確認をやめる", "src/14_main.js",
     "    validateConfig_();\n    requireCalendarService_();\n  } catch (error) {",
     "    validateConfig_();\n  } catch (error) {"),
    ("設定の誤りを黙って落ちる", "src/14_main.js",
     "    log_('設定に問題があるため同期できません: ' + error);\n"
     "    notifyFailure_(error);\n", ""),
    ("情報源が全部 false でも通す", "src/14_main.js",
     "  } else if (!Object.keys(providers).some(function (name) { return providers[name]; })) {",
     "  } else if (false) {"),
    ("落ちた情報源があっても 0 件を正常扱いにする", "src/14_main.js",
     "      const silent = downSources_();\n      if (silent.length) {",
     "      const silent = downSources_();\n      if (false) {"),
    ("該当 0 件をいつでも失敗にする", "src/14_main.js",
     "      const silent = downSources_();\n      if (silent.length) {",
     "      const silent = downSources_();\n      if (true) {"),
    ("時間の上限を見ない", "src/11_sync.js",
     "    if (Date.now() < deadline) return true;", "    return true;"),
    ("書けなかったぶんも「やった」と報告する", "src/11_sync.js",
     "  plan.created = done.created;\n  plan.updated = done.updated;\n"
     "  plan.deleted = done.deleted;\n  plan.truncated = ranOut;",
     "  plan.truncated = ranOut;"),
    ("週次まとめのしきい値を無視する", "src/12_digest.js",
     "      if (event.impact < threshold) return false;", ""),
    ("内容ハッシュによる差分判定をやめる", "src/11_sync.js",
     "  if (storedHash_(item) !== resource.extendedProperties.private.hash) return false;",
     ""),
    ("月をまたぐ押し出しを許す", "src/04_schedule.js",
     "      push(businessDayNearDay_(year, month, Math.min(rule.day || 1, 28)));",
     "      push(nextBusinessDay_(ymd_(year, month, Math.min(rule.day || 1, 28))));"),
    ("日をまたぐ予定も削除対象にする", "src/11_sync.js",
     "    if (ctx && !inPruneRange_(item, ctx)) return;", ""),
    ("曜日の綴り誤りを黙って通す", "src/04_schedule.js",
     "  const value = lookup_(WEEKDAY_NUM, String(name).toLowerCase(), undefined);\n"
     "  if (value === undefined) {",
     "  const value = lookup_(WEEKDAY_NUM, String(name).toLowerCase(), 4);\n"
     "  if (false) {"),
    ("色 ID の検証をやめる", "src/14_main.js",
     "    if (!Number.isInteger(number) || number < 1 || number > 11\n"
     "        || String(number) !== String(color).trim()) {",
     "    if (false) {"),
    ("カタログの検証をやめる", "src/14_main.js",
     "  problems.push.apply(problems, catalogProblems_());", ""),
    ("孤立サロゲートをそのまま符号化する", "src/03_util.js",
     "    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;", ""),
    ("組み立て後ではなくイベントからハッシュを取る", "src/11_sync.js",
     "  resource.extendedProperties.private.hash = resourceContentHash_(resource);",
     "  resource.extendedProperties.private.hash = eventContentHash_(event);"),
    ("既存の中身を引き継がない", "src/11_sync.js",
     "    if (!event.actual && props.a) patch.actual = props.a;", ""),
    ("確かな時刻の記憶を引き継がない", "src/11_sync.js",
     "    if (timeRank_(storedTime) > timeRank_(event.timeSource) && props.at) {",
     "    if (false) {"),
    ("説明文に情報源の名前を書く", "src/10_render.js",
     "  lines.push('自動同期: ' + MARKER + timeNote_(event));",
     "  lines.push('情報源: ' + event.source + ' / 自動同期: ' + MARKER + timeNote_(event));"),
    ("弱い予定でも既存を上書きする", "src/11_sync.js",
     "      if (nearby[i].rank <= mine) continue;", "      if (true) continue;"),
    ("名寄せで発表日を見ない", "src/05_catalog.js",
     "  if (specific.length === 1 || !date) return specific[0].indicator;",
     "  return specific[0].indicator;"),
    ("根拠を指定し忘れたら official に倒す", "src/05_catalog.js",
     "    confidence: hasKey_(CONFIDENCE_RANK, fields.confidence) ? fields.confidence : 'estimated',",
     "    confidence: hasKey_(CONFIDENCE_RANK, fields.confidence) ? fields.confidence : 'official',"),
    ("根拠より情報源の優先順位で日付を決める", "src/05_catalog.js",
     "  if (confidenceRank_(low.confidence) > confidenceRank_(merged.confidence)) {",
     "  if (false) {"),
    ("FOMC の食い違いを黙って手入力優先にする", "src/08_fomc_auto.js",
     "    conflicts.push({ year: year, mine: mineDates, official: officialDates });",
     "    out.push.apply(out, mine); if (true) return;"),
    ("終日への変換をやめる", "src/11_sync.js",
     "  if (event.allDay || CONFIG.display.allDay) {",
     "  if (event.allDay) {"),
    ("推定日の間引きをやめる", "src/09_collect.js",
     "      if (Math.abs(daysBetween_(day, known[i])) <= SUPERSEDE_WINDOW_DAYS) return false;",
     ""),
    ("名寄せの重なりを見ない", "src/14_main.js",
     "  problems.push.apply(problems, matchNameOverlaps_());", ""),
    ("名寄せの重なりを、日付で分かれるものまで問題にする", "src/14_main.js",
     "      const resolves = days.length > 0 && days.every(function (day) {",
     "      const resolves = false && days.every(function (day) {"),
    ("確定の印の矛盾を見ない", "src/14_main.js",
     "    if (schedule.exact) {", "    if (false) {"),
]

RESULT = re.compile(r"(\d+) passed, (\d+) failed")


# 性質テストは件数を減らして回す。変異ひとつごとに 90 件を
# 回すと 20 分を超えてしまう。変異の検出に必要なのは「性質が破れること」
# であって件数ではないので、ここでは少なめにする。
FUZZ_CASES = os.environ.get("MUTATE_FUZZ_N", "20")

# 日を進める通し試験も同じ理由で短くする。変異ひとつの検出に必要なのは
# 「性質が破れること」なので、日数は最小限でよい。
LONG_RUN_DAYS = os.environ.get("MUTATE_LONG_RUN_DAYS", "5")


def run_tests(timeout=240):
    env = dict(os.environ, FUZZ_N=FUZZ_CASES, LONG_RUN_DAYS=LONG_RUN_DAYS)
    try:
        proc = subprocess.run(["node", "tests/run.js"], env=env,
                              capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "時間内に終わらなかった"
    match = None
    for line in proc.stdout.splitlines():
        found = RESULT.search(line)
        if found:
            match = found
    if not match:
        return None, "テスト結果を読み取れなかった"
    return int(match.group(2)), match.group(0)


def restore_all(originals):
    for path, source in originals.items():
        open(path, "w", encoding="utf-8").write(source)


def install_signal_guards(originals):
    """kill されても書き戻す。atexit だけではシグナルで抜けたときに走らない。"""
    def handler(signum, frame):
        restore_all(originals)
        sys.exit(128 + signum)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            signal.signal(sig, handler)
        except (ValueError, OSError):
            pass


def sharded(items):
    """CI では何台かに分けて回す。--shard i/n で i 番目のぶんだけを取る。

    テスト一式を変異の数だけ回すので、1台では時間がかかりすぎる。
    飛ばし飛ばしに取るので、重い変異が1台に固まらない。
    """
    spec = os.environ.get("MUTATE_SHARD", "")
    for i, arg in enumerate(sys.argv):
        if arg == "--shard" and i + 1 < len(sys.argv):
            spec = sys.argv[i + 1]
    if not spec:
        return items
    try:
        index, total = (int(part) for part in spec.split("/", 1))
    except ValueError:
        print(f"--shard の書き方は i/n です: {spec}")
        sys.exit(1)
    if not 1 <= index <= total:
        print(f"--shard の範囲が合いません: {spec}")
        sys.exit(1)
    picked = items[index - 1::total]
    print(f"{total} 分割の {index} 番目: {len(picked)} / {len(items)} 件")
    return picked


def selected(argv):
    """引数があれば、名前に含まれるものだけを回す（部分一致）。"""
    argv = [a for a in argv if not a.startswith("--")]
    # --shard の値そのものが名前として拾われないように落とす
    for i, arg in enumerate(sys.argv):
        if arg == "--shard" and i + 1 < len(sys.argv) and sys.argv[i + 1] in argv:
            argv.remove(sys.argv[i + 1])
    if not argv:
        return sharded(MUTATIONS)
    picked = [m for m in MUTATIONS if any(word in m[0] for word in argv)]
    if not picked:
        print("その名前の変異はありません: " + ", ".join(argv))
    return picked


def check_targets():
    """変異の当て先が、いまのソースにまだ在るかだけを見る（数秒で終わる）。

    修正した場所を後から書き換えると、変異の定義だけが古いまま残る。
    そうなると「⚠️ 対象コードが見つからない」は 30 分の全件実行でしか
    出てこないので、実際に何度も見落とした。ここだけを切り出して、
    lint と同じ速さで回せるようにしておく。
    """
    cache = {}
    stale = []
    for name, path, old, _ in MUTATIONS:
        if path not in cache:
            try:
                cache[path] = open(path, encoding="utf-8").read()
            except OSError as err:
                print(f"⚠️  ファイルが無い  {path}  ({name}): {err}")
                stale.append(name)
                continue
        source = cache[path]
        hits = source.count(old)
        if hits == 0:
            print(f"⚠️  当て先が見つからない  {name}  ({path})")
            stale.append(name)
        elif hits > 1:
            # 置換は 1 箇所目だけ。狙いと違う場所に当たりうる。
            print(f"⚠️  当て先が {hits} 箇所ある  {name}  ({path})")
            stale.append(name)
    print()
    if stale:
        print(f"{len(stale)} 件の変異が、いまのソースに当たりません: " + ", ".join(stale))
        print("変異の定義（tools/mutate.py）を、直した場所に合わせ直してください。")
        return 1
    print(f"全 {len(MUTATIONS)} 件の変異が、いまのソースに当たります")
    return 0


def main():
    argv = sys.argv[1:]
    if "--check" in argv:
        return check_targets()

    targets = selected(argv)
    if not targets:
        return 1

    # 途中で強制終了されても作業ツリーを汚さない。finally だけでは
    # SIGKILL に対応できないので、git でも復元できることを確かめておく。
    dirty = subprocess.run(["git", "diff", "--quiet", "--", "src"]).returncode != 0
    if dirty:
        print("注意: src に未コミットの変更があります。"
              "変異が途中で残った場合、git で戻せません。")

    baseline, summary = run_tests()
    if baseline is None or baseline > 0:
        print(f"変異前のテストが通っていません: {summary}")
        return 1
    print(f"変異前: {summary}\n")

    originals = {}
    for _, path, _, _ in targets:
        originals.setdefault(path, open(path, encoding="utf-8").read())
    # 例外でも Ctrl-C でも、確実に書き戻す
    atexit.register(restore_all, originals)
    install_signal_guards(originals)

    missed = []
    try:
        for name, path, old, new in targets:
            source = originals[path]
            if old not in source:
                print(f"⚠️  対象コードが見つからない  {name}")
                missed.append(name)
                continue
            open(path, "w", encoding="utf-8").write(source.replace(old, new, 1))
            failures, summary = run_tests()
            open(path, "w", encoding="utf-8").write(source)

            caught = failures is not None and failures > 0
            print(("✅ 検出   " if caught else "❌ 見逃し ") + f"{name:34} → {summary}")
            if not caught:
                missed.append(name)
    finally:
        # 途中で落ちても必ず元に戻す
        for path, source in originals.items():
            open(path, "w", encoding="utf-8").write(source)

    print()
    if missed:
        print(f"{len(missed)} 件の修正がテストで守られていません: " + ", ".join(missed))
        return 1
    print(f"全 {len(targets)} 件の修正が回帰テストで守られています")
    return 0


if __name__ == "__main__":
    sys.exit(main())
