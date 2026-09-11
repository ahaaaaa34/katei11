#!/usr/bin/env python3
"""差分テスト（その2）: 同じ計算を、JS を見ずに仕様から独立に書き直して突き合わせる。

実装とテストが同じ思い込みを共有していると、そのぶんは永久に見つからない。
別の言語・別のタイムゾーン実装（Python の zoneinfo は tzdata を直接読む。
V8 は ICU を使う）で書き直し、答えが割れたところだけを見る。
"""

import hashlib
import json
import sys
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

UTC = timezone.utc
problems = {}


def bad(kind, detail):
    problems.setdefault(kind, [])
    if len(problems[kind]) < 6:
        problems[kind].append(str(detail)[:200])


# ---------------------------------------------------------------------------
# 1. 現地の壁時計 -> 絶対時刻
# ---------------------------------------------------------------------------
def check_zoned(rows):
    for y, m, d, hhmm, tz, got in rows:
        hh, mm = (int(x) for x in hhmm.split(":"))
        naive = datetime(y, m, d, hh, mm)
        zone = ZoneInfo(tz)
        # fold=0 が「最初に訪れる方」。JS 側も同じ約束のはず。
        want = naive.replace(tzinfo=zone).astimezone(UTC)
        want_s = want.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        if want_s != got:
            # 存在しない時刻（春の飛ぶ1時間）はどちらの解釈もありうるので分けて数える
            back = datetime.fromisoformat(got.replace("Z", "+00:00")).astimezone(zone)
            kind = "壁時計->絶対時刻"
            if back.replace(tzinfo=None) != naive:
                kind = "壁時計->絶対時刻（存在しない/二度ある時刻）"
            bad(kind, f"{y}-{m:02d}-{d:02d} {hhmm} {tz}: JS={got} Python={want_s}")


# ---------------------------------------------------------------------------
# 2. 絶対時刻 -> 現地の日付
# ---------------------------------------------------------------------------
def check_local(rows):
    for iso, tz, got in rows:
        want = (datetime.fromisoformat(iso.replace("Z", "+00:00"))
                .astimezone(ZoneInfo(tz)).date().isoformat())
        if want != got:
            bad("絶対時刻->現地の日付", f"{iso} {tz}: JS={got} Python={want}")


# ---------------------------------------------------------------------------
# 3. 米国の祝日（法律から素直に書く）
# ---------------------------------------------------------------------------
def nth_weekday(year, month, weekday, n):
    """weekday は月曜=0。n が負なら月末から数える。"""
    if n > 0:
        first = date(year, month, 1)
        shift = (weekday - first.weekday()) % 7
        return first + timedelta(days=shift + 7 * (n - 1))
    last_day = (date(year + month // 12, month % 12 + 1, 1) - timedelta(days=1))
    shift = (last_day.weekday() - weekday) % 7
    return last_day - timedelta(days=shift + 7 * (-n - 1))


def observed(d):
    """土曜なら前日の金曜、日曜なら翌日の月曜に振り替える。"""
    if d.weekday() == 5:
        return d - timedelta(days=1)
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d


def easter(year):
    """Meeus / Jones / Butcher のアルゴリズム（西方教会）。"""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return date(year, month, day + 1)


def federal_holidays(year):
    """その年のうちに休みになる日。元日が土曜の年は前年12月31日に落ちる。"""
    out = {
        nth_weekday(year, 1, 0, 3): "キング牧師誕生日",
        nth_weekday(year, 2, 0, 3): "大統領の日",
        nth_weekday(year, 5, 0, -1): "戦没者追悼の日",
        date(year, 6, 19): "ジューンティーンス",
        date(year, 7, 4): "独立記念日",
        nth_weekday(year, 9, 0, 1): "労働者の日",
        nth_weekday(year, 10, 0, 2): "コロンブスデー",
        date(year, 11, 11): "復員軍人の日",
        nth_weekday(year, 11, 3, 4): "感謝祭",
        date(year, 12, 25): "クリスマス",
    }
    days = {observed(d) for d in out}
    for y in (year, year + 1):
        d = observed(date(y, 1, 1))
        if d.year == year:
            days.add(d)
    return {d.isoformat() for d in days}


def market_holidays(year):
    """取引所の休場。連邦の祝日からコロンブスデーと復員軍人の日を除き、
    聖金曜日を足す。

    NYSE の規則: 休日が土曜なら前日の金曜を休場にする。ただし **その金曜が
    年内最後の取引日になるときは休場にしない**。つまり元日が土曜の年、
    前年12月31日は取引がある（2021-12-31 は実際に取引されている）。
    """
    out = {
        nth_weekday(year, 1, 0, 3): 1,
        nth_weekday(year, 2, 0, 3): 1,
        easter(year) - timedelta(days=2): 0,   # 聖金曜日（振替なし）
        nth_weekday(year, 5, 0, -1): 1,
        date(year, 6, 19): 1,
        date(year, 7, 4): 1,
        nth_weekday(year, 9, 0, 1): 1,
        nth_weekday(year, 11, 3, 4): 1,
        date(year, 12, 25): 1,
    }
    days = {(observed(d) if shift else d) for d, shift in out.items()}
    new_year = date(year, 1, 1)
    if new_year.weekday() != 5:          # 土曜なら前倒ししない（上の例外）
        days.add(observed(new_year))
    return {d.isoformat() for d in days if d.weekday() < 5}


def market_early_closes(year):
    """短縮取引: 独立記念日の前日・感謝祭の翌日・クリスマスイブ。
    休場日と重なる日、週末は出さない。"""
    closed = market_holidays(year)
    cand = [date(year, 7, 3), nth_weekday(year, 11, 3, 4) + timedelta(days=1),
            date(year, 12, 24)]
    out = set()
    for d in cand:
        if d.weekday() >= 5:
            continue
        if d.isoformat() in closed:
            continue
        out.add(d.isoformat())
    return out


def check_calendars(dump):
    for y_s, got in dump["holidays"].items():
        y = int(y_s)
        want = sorted(federal_holidays(y))
        if want != sorted(got):
            bad("連邦の祝日", f"{y}: JS={sorted(set(got) - set(want))} "
                             f"Python={sorted(set(want) - set(got))}")
    for y_s, got in dump["market"].items():
        y = int(y_s)
        want = sorted(market_holidays(y))
        if want != sorted(got):
            bad("市場の休場", f"{y}: JSのみ={sorted(set(got) - set(want))} "
                             f"Pythonのみ={sorted(set(want) - set(got))}")
    for y_s, got in dump["early"].items():
        y = int(y_s)
        want = sorted(market_early_closes(y))
        if want != sorted(got):
            bad("短縮取引", f"{y}: JSのみ={sorted(set(got) - set(want))} "
                           f"Pythonのみ={sorted(set(want) - set(got))}")
    for y_s, got in dump["easter"].items():
        want = easter(int(y_s)).isoformat()
        if want != got:
            bad("復活祭", f"{y_s}: JS={got} Python={want}")


# ---------------------------------------------------------------------------
# 4. 発表規則の展開
# ---------------------------------------------------------------------------
WEEKDAY = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


def is_business_day(d, holidays):
    return d.weekday() < 5 and d.isoformat() not in holidays


def business_days_in_month(year, month, holidays):
    d = date(year, month, 1)
    out = []
    while d.month == month:
        if is_business_day(d, holidays):
            out.append(d)
        d += timedelta(days=1)
    return out


def business_day_near(year, month, day, holidays):
    """その月の day 日ごろを、月内の営業日に寄せる。
    後ろへ送ると月をはみ出すときは、手前へ寄せる。"""
    day = min(day, 28)
    d = date(year, month, day)
    fwd = d
    while fwd.month == month and not is_business_day(fwd, holidays):
        fwd += timedelta(days=1)
    if fwd.month == month:
        return fwd
    back = d
    while not is_business_day(back, holidays):
        back -= timedelta(days=1)
    return back


def rule_dates(rule, start, end, holidays_for):
    kind = rule["type"]
    months = rule.get("months")
    out = []

    def push(d):
        if d is None or d < start or d > end:
            return
        if months and d.month not in months:
            return
        if d not in out:
            out.append(d)

    if kind == "weekly":
        wd = WEEKDAY[rule.get("weekday", "thu")]
        cur = start + timedelta(days=(wd - start.weekday()) % 7)
        while cur <= end:
            cand = cur
            if cand.isoformat() in holidays_for(cand.year):
                cand -= timedelta(days=1)
                while not is_business_day(cand, holidays_for(cand.year)):
                    cand -= timedelta(days=1)
            push(cand)
            cur += timedelta(days=7)
        return sorted(out)

    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        if not months or m in months:
            hol = holidays_for(y)
            if kind == "nth_business_day":
                days = business_days_in_month(y, m, hol)
                n = rule.get("n", 1)
                idx = n - 1 if n > 0 else len(days) + n
                if 0 <= idx < len(days):
                    push(days[idx])
            elif kind == "nth_weekday":
                d = nth_weekday(y, m, WEEKDAY[rule.get("weekday", "fri")], rule.get("n", 1))
                if d.month == m:
                    push(d)
            elif kind == "day_of_month":
                push(business_day_near(y, m, rule.get("day", 1), hol))
        m += 1
        if m > 12:
            m = 1
            y += 1
    return sorted(out)


RULES = {
    "weekly_thu": {"type": "weekly", "weekday": "thu"},
    "weekly_wed": {"type": "weekly", "weekday": "wed"},
    "nbd_1": {"type": "nth_business_day", "n": 1},
    "nbd_3": {"type": "nth_business_day", "n": 3},
    "nbd_5": {"type": "nth_business_day", "n": 5},
    "nbd_last": {"type": "nth_business_day", "n": -1},
    "nbd_last2": {"type": "nth_business_day", "n": -2},
    "nw_fri_1": {"type": "nth_weekday", "weekday": "fri", "n": 1},
    "nw_fri_2": {"type": "nth_weekday", "weekday": "fri", "n": 2},
    "nw_fri_last": {"type": "nth_weekday", "weekday": "fri", "n": -1},
    "nw_tue_last": {"type": "nth_weekday", "weekday": "tue", "n": -1},
    "nw_thu_3": {"type": "nth_weekday", "weekday": "thu", "n": 3},
    "dom_1": {"type": "day_of_month", "day": 1},
    "dom_12": {"type": "day_of_month", "day": 12},
    "dom_15": {"type": "day_of_month", "day": 15},
    "dom_27": {"type": "day_of_month", "day": 27},
    "dom_28": {"type": "day_of_month", "day": 28},
    "nw_fri_last_q": {"type": "nth_weekday", "weekday": "fri", "n": -1,
                      "months": [1, 4, 7, 10]},
    "dom_7_q": {"type": "day_of_month", "day": 7, "months": [2, 5, 8, 11]},
}


def check_rules(dump):
    cache = {}

    def holidays_for(year):
        if year not in cache:
            cache[year] = federal_holidays(year)
        return cache[year]

    start, end = date(2024, 1, 1), date(2032, 12, 31)
    for name, rule in RULES.items():
        want = [d.isoformat() for d in rule_dates(rule, start, end, holidays_for)]
        got = dump["rules"][name]
        if want != got:
            only_js = sorted(set(got) - set(want))[:5]
            only_py = sorted(set(want) - set(got))[:5]
            bad("発表規則の展開",
                f"{name}: 件数 JS={len(got)} Python={len(want)} "
                f"JSのみ={only_js} Pythonのみ={only_py}")


def check_business_near(dump):
    cache = {}

    def holidays_for(year):
        if year not in cache:
            cache[year] = federal_holidays(year)
        return cache[year]

    for y, m, d, got in dump["businessNear"]:
        want = business_day_near(y, m, d, holidays_for(y)).isoformat()
        if want != got:
            bad("月内の営業日への寄せ", f"{y}-{m:02d} {d}日ごろ: JS={got} Python={want}")


# ---------------------------------------------------------------------------
# 5. SHA-1 と base32hex
# ---------------------------------------------------------------------------
B32 = "0123456789abcdefghijklmnopqrstuv"


def base32hex(data):
    out = []
    bits = 0
    value = 0
    for byte in data:
        value = (value << 8) | byte
        bits += 8
        while bits >= 5:
            bits -= 5
            out.append(B32[(value >> bits) & 31])
    if bits:
        out.append(B32[(value << (5 - bits)) & 31])
    return "".join(out)


def check_sha1(dump):
    for text, got_hex, got_b32 in dump["sha1"]:
        digest = hashlib.sha1(text.encode("utf-8")).digest()
        if digest.hex() != got_hex:
            bad("SHA-1", f"{text[:40]!r}: JS={got_hex} Python={digest.hex()}")
        if base32hex(digest) != got_b32:
            bad("base32hex", f"{text[:40]!r}: JS={got_b32} Python={base32hex(digest)}")


# ---------------------------------------------------------------------------
# 6. 対象期間のラベル
# ---------------------------------------------------------------------------
def check_period(dump):
    for y, m, off, got in dump["period"]:
        if off == 0:
            want = None
        else:
            idx = (m - 1) + off
            want = f"{y + (idx // 12)}年{(idx % 12) + 1}月分"
        if want != got:
            bad("対象期間のラベル", f"{y}-{m:02d} offset={off}: JS={got} Python={want}")


# ---------------------------------------------------------------------------
def main():
    dump = json.load(open(sys.argv[1], encoding="utf-8"))
    check_zoned(dump["zoned"])
    check_local(dump["local"])
    check_calendars(dump)
    check_rules(dump)
    check_business_near(dump)
    check_sha1(dump)
    check_period(dump)

    total = (len(dump["zoned"]) + len(dump["local"]) + len(dump["sha1"])
             + len(dump["period"]) + len(dump["businessNear"])
             + sum(len(v) for v in dump["rules"].values()))
    print(f"{total} 件を独立実装と突き合わせた")
    if not problems:
        print("\n食い違いなし")
        return 0
    for kind, rows in problems.items():
        print(f"\n[x] {kind} ({len(rows)}件まで表示)")
        for r in rows:
            print("    " + r)
    return 1


if __name__ == "__main__":
    sys.exit(main())
