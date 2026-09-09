"""Core data structures shared by providers, scoring and the calendar sync."""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any

TIERS = ("S", "A", "B", "C")

#: Provider precedence when two providers report the same indicator on the same
#: local day.  Higher wins, because those sources carry richer or more
#: authoritative data (exact clock time, consensus, actual result).
SOURCE_PRIORITY = {
    "rules": 10,
    "market": 20,
    "fomc": 30,
    "earnings": 40,
    # investing は予想・結果の数値を持つ唯一の情報源だが、日付の確度は
    # 公式カレンダーである FRED に劣るため一段下に置く。merged_with が
    # 「日時は上位、空欄の値は下位から」で合成するのでこれで両取りになる。
    "investing": 50,
    "fred": 60,
}


def tier_for(score: int) -> str:
    """Map a 0-100 Nasdaq impact score onto a coarse tier label."""
    if score >= 90:
        return "S"
    if score >= 75:
        return "A"
    if score >= 55:
        return "B"
    return "C"


@dataclass
class EconEvent:
    """A single dated item destined for the calendar.

    ``start``/``end`` are always timezone-aware.  Providers build them in the
    release's own timezone (usually ``America/New_York``); conversion to the
    user's display timezone happens at render time.
    """

    indicator_id: str
    title: str
    start: datetime
    end: datetime
    impact: int
    country: str = "US"
    category: str = "other"
    source: str = "rules"
    all_day: bool = False
    estimated: bool = False
    period: str | None = None
    actual: str | None = None
    forecast: str | None = None
    previous: str | None = None
    unit: str | None = None
    note: str = ""
    url: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.start.tzinfo is None or self.end.tzinfo is None:
            raise ValueError(f"{self.indicator_id}: start/end must be timezone-aware")
        if self.end < self.start:
            raise ValueError(f"{self.indicator_id}: end precedes start")
        self.impact = max(0, min(100, int(self.impact)))

    # -- identity -----------------------------------------------------------

    @property
    def tier(self) -> str:
        return tier_for(self.impact)

    def uid(self, tz) -> str:
        """Stable identity: one indicator, one local calendar day.

        Keyed on the *display* date so a release that slips by a couple of
        hours updates the existing event instead of creating a second one.
        """
        return f"{self.indicator_id}@{self.start.astimezone(tz).date().isoformat()}"

    def gcal_id(self, tz) -> str:
        """Deterministic Google Calendar event id derived from :meth:`uid`.

        Google only accepts base32hex characters (``0-9a-v``), 5-1024 long, and
        requires ids to be unique per calendar -- a hash of the uid satisfies
        both while letting us upsert without keeping a local database.
        """
        digest = hashlib.sha1(self.uid(tz).encode("utf-8")).digest()
        return "ec" + base64.b32hexencode(digest).decode("ascii").lower().rstrip("=")

    def content_hash(self) -> str:
        """Hash of everything we render, used to skip no-op calendar updates."""
        payload = "|".join(
            str(x)
            for x in (
                self.title,
                self.start.isoformat(),
                self.end.isoformat(),
                self.impact,
                self.all_day,
                self.estimated,
                self.period,
                self.actual,
                self.forecast,
                self.previous,
                self.unit,
                self.note,
                self.url,
                self.source,
            )
        )
        return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]

    # -- merging ------------------------------------------------------------

    def merged_with(self, other: EconEvent) -> EconEvent:
        """Combine two reports of the same event, preferring the richer source.

        The higher-priority source supplies timing and identity; the other
        backfills any field it left empty, so a FRED-confirmed date can still
        pick up a consensus figure that only the scraper reported.
        """
        hi, lo = self, other
        if SOURCE_PRIORITY.get(other.source, 0) > SOURCE_PRIORITY.get(self.source, 0):
            hi, lo = other, self

        fill: dict[str, Any] = {}
        for name in ("actual", "forecast", "previous", "unit", "period", "url"):
            if getattr(hi, name) in (None, "") and getattr(lo, name) not in (None, ""):
                fill[name] = getattr(lo, name)
        if not hi.note and lo.note:
            fill["note"] = lo.note
        # A confirmed date from any source beats an estimate from another.
        if hi.estimated and not lo.estimated:
            fill.update(estimated=False, start=lo.start, end=lo.end)
        fill["extra"] = {**lo.extra, **hi.extra}
        return replace(hi, **fill)
