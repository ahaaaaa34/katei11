"""Loading and querying the indicator catalog."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import yaml

from .models import tier_for

DATA_DIR = Path(__file__).parent / "data"
INDICATORS_FILE = DATA_DIR / "indicators.yaml"
MEETINGS_FILE = DATA_DIR / "meetings.yaml"


@dataclass(frozen=True)
class Indicator:
    id: str
    name: str
    country: str
    category: str
    impact: int
    time: str | None = None
    duration: int = 30
    all_day: bool = False
    period_offset: int = 0
    tz: str = "America/New_York"
    why: str = ""
    url: str | None = None
    schedule: dict[str, Any] = field(default_factory=dict)
    fred_release: str | None = None
    match: tuple[str, ...] = ()

    @property
    def tier(self) -> str:
        return tier_for(self.impact)

    @property
    def zoneinfo(self) -> ZoneInfo:
        return ZoneInfo(self.tz)

    @property
    def has_rule(self) -> bool:
        return bool(self.schedule) and self.schedule.get("type", "none") != "none"

    @property
    def rule_is_exact(self) -> bool:
        return bool(self.schedule.get("exact", False))


class Catalog:
    """The indicator set, plus the lookups providers need."""

    def __init__(self, indicators: list[Indicator]):
        self.indicators = indicators
        self._by_id = {i.id: i for i in indicators}
        # Longer patterns first so "core cpi" wins over a bare "cpi" pattern.
        self._matchers: list[tuple[re.Pattern[str], Indicator]] = sorted(
            (
                (re.compile(p, re.IGNORECASE), ind)
                for ind in indicators
                for p in ind.match
            ),
            key=lambda pair: -len(pair[0].pattern),
        )
        self._fred: list[tuple[re.Pattern[str], Indicator]] = [
            (re.compile(i.fred_release, re.IGNORECASE), i)
            for i in indicators
            if i.fred_release
        ]

    def __iter__(self):
        return iter(self.indicators)

    def __len__(self) -> int:
        return len(self.indicators)

    def get(self, indicator_id: str) -> Indicator | None:
        return self._by_id.get(indicator_id)

    def require(self, indicator_id: str) -> Indicator:
        ind = self._by_id.get(indicator_id)
        if ind is None:
            raise KeyError(f"unknown indicator id: {indicator_id}")
        return ind

    def match_name(self, name: str) -> Indicator | None:
        """Map a free-form event name from an external feed onto an indicator."""
        for pattern, ind in self._matchers:
            if pattern.search(name):
                return ind
        return None

    def match_fred_release(self, release_name: str) -> Indicator | None:
        for pattern, ind in self._fred:
            if pattern.search(release_name):
                return ind
        return None

    def with_rules(self) -> list[Indicator]:
        return [i for i in self.indicators if i.has_rule]

    def above(self, min_impact: int) -> list[Indicator]:
        return [i for i in self.indicators if i.impact >= min_impact]


def _to_indicator(raw: dict[str, Any]) -> Indicator:
    known = set(Indicator.__dataclass_fields__)
    unknown = set(raw) - known
    if unknown:
        raise ValueError(f"{raw.get('id')}: unknown catalog keys {sorted(unknown)}")
    data = dict(raw)
    data["match"] = tuple(data.get("match") or ())
    data.setdefault("schedule", {})
    return Indicator(**data)


@cache
def load_catalog(path: str | None = None) -> Catalog:
    src = Path(path) if path else INDICATORS_FILE
    raw = yaml.safe_load(src.read_text(encoding="utf-8"))
    indicators = [_to_indicator(item) for item in raw["indicators"]]
    seen: set[str] = set()
    for ind in indicators:
        if ind.id in seen:
            raise ValueError(f"duplicate indicator id: {ind.id}")
        seen.add(ind.id)
        if ind.has_rule and not ind.all_day and not ind.time:
            raise ValueError(f"{ind.id}: scheduled indicator needs a `time`")
    return Catalog(indicators)


@cache
def load_meetings(path: str | None = None) -> dict[str, Any]:
    src = Path(path) if path else MEETINGS_FILE
    return yaml.safe_load(src.read_text(encoding="utf-8"))
