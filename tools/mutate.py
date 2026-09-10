#!/usr/bin/env python3
"""変異テスト：修正を一時的に巻き戻し、回帰テストが本当に落ちるかを見る。

テストが通ることは、そのテストが意味を持つことを保証しない。
バグを入れ直して落ちなければ、そのテストは何も守っていない。
"""

import re
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
    ("手入力の会合日程を自動取得で上書きする", "src/08_fomc_auto.js",
     "    if (Number(year) <= maxYear) return;   // 手入力がある年は触らない", ""),
    ("拡張サービスの確認をやめる", "src/14_main.js",
     "function syncCalendar() {\n  validateConfig_();\n  requireCalendarService_();",
     "function syncCalendar() {\n  validateConfig_();"),
    ("週次まとめのしきい値を無視する", "src/12_digest.js",
     "      if (event.impact < threshold) return false;", ""),
    ("内容ハッシュによる差分判定をやめる", "src/11_sync.js",
     "    } else if (storedHash_(current) === eventContentHash_(event)) {",
     "    } else if (false) {"),
    ("月をまたぐ押し出しを許す", "src/04_schedule.js",
     "      push(businessDayNearDay_(year, month, Math.min(rule.day || 1, 28)));",
     "      push(nextBusinessDay_(ymd_(year, month, Math.min(rule.day || 1, 28))));"),
    ("推定日の間引きをやめる", "src/09_collect.js",
     "      if (Math.abs(daysBetween_(day, known[i])) <= SUPERSEDE_WINDOW_DAYS) return false;",
     ""),
]

RESULT = re.compile(r"(\d+) passed, (\d+) failed")


def run_tests(timeout=120):
    try:
        proc = subprocess.run(["node", "tests/run.js"],
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


def main():
    baseline, summary = run_tests()
    if baseline is None or baseline > 0:
        print(f"変異前のテストが通っていません: {summary}")
        return 1
    print(f"変異前: {summary}\n")

    originals = {}
    for _, path, _, _ in MUTATIONS:
        originals.setdefault(path, open(path, encoding="utf-8").read())

    missed = []
    try:
        for name, path, old, new in MUTATIONS:
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
    print(f"全 {len(MUTATIONS)} 件の修正が回帰テストで守られています")
    return 0


if __name__ == "__main__":
    sys.exit(main())
