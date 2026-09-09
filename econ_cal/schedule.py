"""US market calendar helpers and the recurrence-rule engine.

Most US macro releases follow a rule that can be evaluated offline ("first
business day of the month", "every Thursday", "second Friday").  Evaluating
those locally means the tool produces a usable calendar with no API key and no
network at all; authoritative providers then refine the dates they cover.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

WEEKDAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
ET = ZoneInfo("America/New_York")


# ---------------------------------------------------------------------------
# holidays
# ---------------------------------------------------------------------------

def easter(year: int) -> date:
    """Gregorian Easter Sunday (anonymous / Meeus algorithm)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    ll = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * ll) // 451
    month, day = divmod(h + ll - 7 * m + 114, 31)
    return date(year, month, day + 1)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """n-th ``weekday`` of the month (n>=1); ``n=-1`` means the last one."""
    if n < 0:
        d = date(year, month, 1) + timedelta(days=32)
        d = date(d.year, d.month, 1) - timedelta(days=1)  # last day of month
        while d.weekday() != weekday:
            d -= timedelta(days=1)
        return d
    d = date(year, month, 1)
    d += timedelta(days=(weekday - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def _observed(d: date) -> date:
    """Federal observance: Saturday holidays move back, Sunday holidays move up."""
    if d.weekday() == 5:
        return d - timedelta(days=1)
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d


def federal_holidays(year: int) -> dict[date, str]:
    """Federal holidays, when the statistical agencies are shut."""
    return {
        _observed(date(year, 1, 1)): "元日",
        _nth_weekday(year, 1, WEEKDAYS["mon"], 3): "キング牧師記念日",
        _nth_weekday(year, 2, WEEKDAYS["mon"], 3): "大統領の日",
        _nth_weekday(year, 5, WEEKDAYS["mon"], -1): "戦没者追悼記念日",
        _observed(date(year, 6, 19)): "ジューンティーンス",
        _observed(date(year, 7, 4)): "独立記念日",
        _nth_weekday(year, 9, WEEKDAYS["mon"], 1): "レイバーデー",
        _nth_weekday(year, 10, WEEKDAYS["mon"], 2): "コロンブスデー",
        _observed(date(year, 11, 11)): "ベテランズデー",
        _nth_weekday(year, 11, WEEKDAYS["thu"], 4): "感謝祭",
        _observed(date(year, 12, 25)): "クリスマス",
    }


def market_holidays(year: int) -> dict[date, str]:
    """NYSE / Nasdaq full closures.

    Differs from the federal list: the exchanges trade on Columbus Day and
    Veterans Day but close on Good Friday.  A Saturday holiday does not create
    a Friday closure for New Year's Day, which is why it is handled separately.
    """
    out = {
        _nth_weekday(year, 1, WEEKDAYS["mon"], 3): "キング牧師記念日",
        _nth_weekday(year, 2, WEEKDAYS["mon"], 3): "大統領の日",
        easter(year) - timedelta(days=2): "グッドフライデー",
        _nth_weekday(year, 5, WEEKDAYS["mon"], -1): "戦没者追悼記念日",
        _observed(date(year, 6, 19)): "ジューンティーンス",
        _observed(date(year, 7, 4)): "独立記念日",
        _nth_weekday(year, 9, WEEKDAYS["mon"], 1): "レイバーデー",
        _nth_weekday(year, 11, WEEKDAYS["thu"], 4): "感謝祭",
        _observed(date(year, 12, 25)): "クリスマス",
    }
    new_year = date(year, 1, 1)
    if new_year.weekday() != 5:  # a Saturday New Year does not close the Friday
        out[_observed(new_year)] = "元日"
    return {d: name for d, name in out.items() if d.weekday() < 5}


def market_early_closes(year: int) -> dict[date, str]:
    """Half-days (13:00 ET close)."""
    out: dict[date, str] = {}
    july3 = date(year, 7, 3)
    if july3.weekday() < 5 and date(year, 7, 4).weekday() < 5:
        out[july3] = "独立記念日前日"
    out[_nth_weekday(year, 11, WEEKDAYS["thu"], 4) + timedelta(days=1)] = "感謝祭翌日"
    dec24 = date(year, 12, 24)
    if dec24.weekday() < 5:
        out[dec24] = "クリスマスイブ"
    holidays = market_holidays(year)
    return {d: n for d, n in out.items() if d not in holidays}


def is_business_day(d: date, holidays: dict[date, str] | None = None) -> bool:
    if d.weekday() >= 5:
        return False
    hol = holidays if holidays is not None else federal_holidays(d.year)
    return d not in hol


def next_business_day(d: date) -> date:
    while not is_business_day(d):
        d += timedelta(days=1)
    return d


def prev_business_day(d: date) -> date:
    while not is_business_day(d):
        d -= timedelta(days=1)
    return d


def business_days_in_month(year: int, month: int) -> list[date]:
    hol = federal_holidays(year)
    d = date(year, month, 1)
    out = []
    while d.month == month:
        if is_business_day(d, hol):
            out.append(d)
        d += timedelta(days=1)
    return out


# ---------------------------------------------------------------------------
# recurrence rules
# ---------------------------------------------------------------------------

def _months_between(start: date, end: date) -> Iterable[tuple[int, int]]:
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def rule_dates(rule: dict, start: date, end: date) -> list[date]:
    """Expand a schedule rule into concrete dates within ``[start, end]``.

    Supported ``type`` values:

    ``nth_business_day``      n-th business day of the month (negative counts
                              back from the end, ``-1`` = last business day)
    ``nth_weekday``           n-th weekday of the month (``-1`` = last)
    ``day_of_month``          fixed day, pushed to the next business day
    ``weekly``                every given weekday, pulled back one day when the
                              week contains a holiday (how jobless claims move)
    """
    kind = rule.get("type", "nth_business_day")
    months = set(rule.get("months") or range(1, 13))
    out: list[date] = []

    if kind == "weekly":
        wd = WEEKDAYS[rule.get("weekday", "thu")]
        d = start
        d += timedelta(days=(wd - d.weekday()) % 7)
        while d <= end:
            candidate = d
            # Agencies pull a release forward when a holiday falls earlier in
            # the same week, so walk back over any holiday on the target day.
            hol = federal_holidays(candidate.year)
            if candidate in hol:
                candidate -= timedelta(days=1)
                while not is_business_day(candidate):
                    candidate -= timedelta(days=1)
            if start <= candidate <= end and candidate.month in months:
                out.append(candidate)
            d += timedelta(weeks=1)
        return sorted(set(out))

    for year, month in _months_between(start, end):
        if month not in months:
            continue
        if kind == "nth_business_day":
            days = business_days_in_month(year, month)
            n = int(rule.get("n", 1))
            idx = n - 1 if n > 0 else n
            if -len(days) <= idx < len(days):
                out.append(days[idx])
        elif kind == "nth_weekday":
            wd = WEEKDAYS[rule.get("weekday", "fri")]
            d = _nth_weekday(year, month, wd, int(rule.get("n", 1)))
            if d.month == month:
                out.append(d)
        elif kind == "day_of_month":
            day = min(int(rule.get("day", 1)), 28)
            out.append(next_business_day(date(year, month, day)))
        else:
            raise ValueError(f"unknown schedule rule type: {kind!r}")

    return sorted({d for d in out if start <= d <= end})


def at_local_time(d: date, hhmm: str, tz: ZoneInfo = ET) -> datetime:
    """Attach a wall-clock time in ``tz`` (DST-correct via zoneinfo)."""
    hour, minute = (int(x) for x in hhmm.split(":"))
    return datetime.combine(d, time(hour, minute), tzinfo=tz)
