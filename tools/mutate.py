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
    ("真夜中の時の正規化をやめる", "src/04_schedule.js",
     "  out.hour = out.hour % 24;\n", ""),
    ("設定の検証をやめる", "src/14_main.js",
     "function syncCalendar() {\n  validateConfig_();", "function syncCalendar() {"),
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
     "  const problems = configProblems_();\n"
     "  if (problems.length) {",
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
    ("型の名前にプロトタイプの鍵を通す", "src/05_catalog.js",
     "  return typeof name === 'string'\n"
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
     "  return applyFilter_([restored]).length > 0;", "  return true;"),
    ("FRED の対応付けの重なりを見ない", "src/14_main.js",
     "  problems.push.apply(problems, fredReleaseOverlaps_());", ""),
    ("拡張サービスの確認をやめる", "src/14_main.js",
     "function syncCalendar() {\n  validateConfig_();\n  requireCalendarService_();",
     "function syncCalendar() {\n  validateConfig_();"),
    ("週次まとめのしきい値を無視する", "src/12_digest.js",
     "      if (event.impact < threshold) return false;", ""),
    ("内容ハッシュによる差分判定をやめる", "src/11_sync.js",
     "    } else if (storedHash_(current) === resource.extendedProperties.private.hash) {",
     "    } else if (false) {"),
    ("月をまたぐ押し出しを許す", "src/04_schedule.js",
     "      push(businessDayNearDay_(year, month, Math.min(rule.day || 1, 28)));",
     "      push(nextBusinessDay_(ymd_(year, month, Math.min(rule.day || 1, 28))));"),
    ("日をまたぐ予定も削除対象にする", "src/11_sync.js",
     "    if (ctx && !inPruneRange_(item, ctx)) return;", ""),
    ("曜日の綴り誤りを黙って通す", "src/04_schedule.js",
     "  const value = WEEKDAY_NUM[String(name).toLowerCase()];\n  if (value === undefined) {",
     "  const value = WEEKDAY_NUM[String(name).toLowerCase()];\n  if (false) {"),
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
     "    confidence: CONFIDENCE_RANK[fields.confidence] ? fields.confidence : 'estimated',",
     "    confidence: CONFIDENCE_RANK[fields.confidence] ? fields.confidence : 'official',"),
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
]

RESULT = re.compile(r"(\d+) passed, (\d+) failed")


# 性質テストは件数を減らして回す。44 通りの変異それぞれで 90 件を
# 回すと 20 分を超えてしまう。変異の検出に必要なのは「性質が破れること」
# であって件数ではないので、ここでは少なめにする。
FUZZ_CASES = os.environ.get("MUTATE_FUZZ_N", "20")


def run_tests(timeout=180):
    env = dict(os.environ, FUZZ_N=FUZZ_CASES)
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


def selected(argv):
    """引数があれば、名前に含まれるものだけを回す（部分一致）。"""
    if not argv:
        return MUTATIONS
    picked = [m for m in MUTATIONS if any(word in m[0] for word in argv)]
    if not picked:
        print("その名前の変異はありません: " + ", ".join(argv))
    return picked


def main():
    targets = selected(sys.argv[1:])
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
