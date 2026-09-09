"""Weekly digest: a single all-day entry summarising the week ahead.

Scrolling a calendar tells you what is on each day but not which week is the
dangerous one.  A Monday all-day event that lists the week's S/A-rank releases
gives that at a glance, and because it is emitted as a normal event it goes
through the same idempotent sync as everything else.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta

from . import render
from .config import Config
from .models import EconEvent

DIGEST_ID = "digest_weekly"
DEFAULT_THRESHOLD = 75  # A ランク以上を「今週の注目」とする


def week_starts(start: date, end: date) -> list[date]:
    """Every Monday within the window (including the one covering ``start``)."""
    first = start - timedelta(days=start.weekday())
    out, day = [], first
    while day <= end:
        out.append(day)
        day += timedelta(days=7)
    return out


def weekly_events(
    events: list[EconEvent],
    config: Config,
    start: date,
    end: date,
    threshold: int = DEFAULT_THRESHOLD,
) -> list[EconEvent]:
    if not config.get("digest.weekly_event", True):
        return []

    tz = config.tz
    out: list[EconEvent] = []
    for monday in week_starts(start, end):
        if monday < start:
            continue  # 週の途中から始まる同期範囲では初週の要約は作らない
        sunday = monday + timedelta(days=6)
        week = [
            e
            for e in events
            if monday <= e.start.astimezone(tz).date() <= sunday and e.impact >= threshold
        ]
        if not week:
            continue

        week.sort(key=lambda e: e.start)
        top = sum(1 for e in week if e.tier == "S")
        anchor = datetime.combine(monday, time.min, tzinfo=tz)
        headline = "・".join(e.title for e in week if e.tier == "S") or week[0].title
        out.append(
            EconEvent(
                indicator_id=DIGEST_ID,
                title=f"今週の注目指標 {len(week)}件" + (f"（最重要 {top}件）" if top else ""),
                start=anchor,
                end=anchor + timedelta(days=1),
                impact=1,  # 通知は出さず、色も控えめにする
                country="US",
                category="market",
                source="digest",
                all_day=True,
                note=("今週の山場: " + headline + "\n\n") + "\n".join(
                    render.one_line(e, config) for e in week
                ),
            )
        )
    return out


def digest_text(events: list[EconEvent], config: Config, start: date, end: date) -> str:
    """Markdown summary for a webhook or the terminal."""
    tz = config.tz
    lines = [f"📊 経済指標 {start:%m/%d} 〜 {end:%m/%d}", ""]
    current: date | None = None
    for event in sorted(events, key=lambda e: e.start):
        day = event.start.astimezone(tz).date()
        if day != current:
            current = day
            lines.append(f"*{day:%m/%d}({render.WEEKDAY_JA[day.weekday()]})*")
        lines.append("  " + render.one_line(event, config))
    if len(lines) == 2:
        lines.append("（該当なし）")
    return "\n".join(lines)
