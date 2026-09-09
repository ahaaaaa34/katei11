"""FRED provider: authoritative release dates from the St. Louis Fed.

FRED publishes the official release calendar for most US statistical agencies,
including dates that have not happened yet.  It gives the *date* only, so the
catalog's standard release time is applied on top -- but a date confirmed here
outranks anything the rule engine guessed.

Requires a free API key: https://fred.stlouisfed.org/docs/api/api_key.html
"""

from __future__ import annotations

import os
from datetime import date, timedelta

from ..models import EconEvent
from ..schedule import at_local_time
from ..util import FetchError, cached_json, http_json, log
from .base import FetchContext

API = "https://api.stlouisfed.org/fred"
PAGE = 1000
RELEASES_TTL = 7 * 24 * 3600


class FredProvider:
    name = "fred"

    def __init__(self, api_key: str | None = None, api_key_env: str = "FRED_API_KEY"):
        self.api_key = api_key or os.environ.get(api_key_env, "")

    def fetch(self, ctx: FetchContext) -> list[EconEvent]:
        if not self.api_key:
            raise FetchError(
                "FRED の API キーがありません。https://fred.stlouisfed.org/docs/api/api_key.html "
                "で無料取得し、環境変数 FRED_API_KEY に設定してください。"
            )
        rows = self._release_dates(ctx.start, ctx.end)
        names = self._release_names() if any("release_name" not in r for r in rows) else {}

        events: list[EconEvent] = []
        for row in rows:
            name = row.get("release_name") or names.get(row.get("release_id"), "")
            if not name:
                continue
            ind = ctx.catalog.match_fred_release(name)
            if ind is None:
                continue
            day = date.fromisoformat(row["date"])
            if not ctx.start <= day <= ctx.end:
                continue
            start = at_local_time(day, ind.time, ind.zoneinfo)
            events.append(
                EconEvent(
                    indicator_id=ind.id,
                    title=ind.name,
                    start=start,
                    end=start + timedelta(minutes=ind.duration),
                    impact=ind.impact,
                    country=ind.country,
                    category=ind.category,
                    source=self.name,
                    estimated=False,
                    period=_period_label(day, ind.period_offset),
                    note=ind.why,
                    url=ind.url,
                    extra={"fred_release": name},
                )
            )
        log.debug("fred: %s rows -> %s matched events", len(rows), len(events))
        return events

    # -- api ----------------------------------------------------------------

    def _release_dates(self, start: date, end: date) -> list[dict]:
        """Every scheduled release date in the window, across all releases."""
        rows: list[dict] = []
        offset = 0
        while True:
            payload = http_json(
                f"{API}/releases/dates",
                params={
                    "api_key": self.api_key,
                    "file_type": "json",
                    "realtime_start": start.isoformat(),
                    "realtime_end": end.isoformat(),
                    "include_release_dates_with_no_data": "true",
                    "sort_order": "asc",
                    "limit": PAGE,
                    "offset": offset,
                },
            )
            page = payload.get("release_dates", [])
            rows += page
            offset += PAGE
            if len(page) < PAGE or offset >= payload.get("count", 0):
                return rows

    def _release_names(self) -> dict[int, str]:
        def produce() -> dict[str, str]:
            payload = http_json(
                f"{API}/releases",
                params={"api_key": self.api_key, "file_type": "json", "limit": PAGE},
            )
            return {str(r["id"]): r["name"] for r in payload.get("releases", [])}

        raw = cached_json("fred:releases", RELEASES_TTL, produce)
        return {int(k): v for k, v in raw.items()}


def _period_label(day: date, offset: int) -> str | None:
    if offset == 0:
        return None
    index = day.month - 1 + offset
    return f"{day.year + index // 12}年{index % 12 + 1}月分"
