"""Investing.com provider (opt-in): consensus, previous and actual figures.

This is the only source here that carries the *numbers* -- forecast, previous
and the released actual -- which is what makes a past event on the calendar
worth looking back at.  It is also the only source that is not an official API:
it reads the site's public economic-calendar endpoint, so it can break without
notice and is therefore disabled by default.

Timing from this provider is deliberately ranked below FRED (see
``SOURCE_PRIORITY``); its value is the figures, not the clock.
"""

from __future__ import annotations

import html
import json
import re
from datetime import datetime, timedelta
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

from ..models import EconEvent
from ..util import FetchError, http_post, log
from .base import FetchContext

ENDPOINT = "https://www.investing.com/economic-calendar/Service/getCalendarFilteredData"
REFERER = "https://www.investing.com/economic-calendar/"

#: サイト内部の国 ID。カタログの country コードとの対応表。
COUNTRY_IDS = {"US": 5, "JP": 35, "EU": 72, "CN": 37, "GB": 4, "DE": 17}

#: 重要度アイコン (bull1/2/3) → おおよその重要度。カタログにマッチしない
#: イベントを落とすかどうかの判断にだけ使う。
IMPORTANCE = {"1": 30, "2": 55, "3": 80}


class _RowParser(HTMLParser):
    """Pull one dict per ``<tr>`` out of the fragment the endpoint returns.

    Written defensively: unknown markup is ignored rather than raising, so a
    layout tweak upstream degrades to fewer rows instead of a crash.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[dict] = []
        self._row: dict | None = None
        self._cell: str | None = None
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs_list) -> None:
        attrs = dict(attrs_list)
        if tag == "tr":
            self._row = {
                "datetime": attrs.get("data-event-datetime", ""),
                "id": attrs.get("id", ""),
                "cells": {},
            }
        elif tag == "td" and self._row is not None:
            classes = (attrs.get("class") or "").split()
            cell_id = attrs.get("id") or ""
            if "sentiment" in classes:
                self._row["importance"] = str(attrs.get("data-img_key", "")).replace("bull", "")
                self._row["importance_title"] = attrs.get("title", "")
            for key, marker in (
                ("time", "js-time"),
                ("currency", "flagCur"),
                ("event", "event"),
            ):
                if marker in classes:
                    self._cell = key
            for key, prefix in (
                ("actual", "eventActual_"),
                ("forecast", "eventForecast_"),
                ("previous", "eventPrevious_"),
            ):
                if cell_id.startswith(prefix):
                    self._cell = key
            self._buf = []
        elif tag == "a" and self._cell == "event" and attrs.get("href"):
            self._row.setdefault("url", "https://www.investing.com" + attrs["href"])

    def handle_data(self, data: str) -> None:
        if self._cell:
            self._buf.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "td" and self._row is not None and self._cell:
            text = re.sub(r"\s+", " ", "".join(self._buf)).strip()
            self._row["cells"][self._cell] = text
            self._cell = None
            self._buf = []
        elif tag == "tr" and self._row is not None:
            if self._row["cells"].get("event"):
                self.rows.append(self._row)
            self._row = None


class InvestingProvider:
    name = "investing"

    def __init__(self, timeout: int = 20, timezone_id: int = 55, assume_tz: str = "UTC"):
        self.timeout = timeout
        self.timezone_id = timezone_id
        self.assume_tz = ZoneInfo(assume_tz)

    def fetch(self, ctx: FetchContext) -> list[EconEvent]:
        wanted = [c for c in ctx.config.get("filter.countries", []) if c in COUNTRY_IDS]
        payload = {
            "country[]": [COUNTRY_IDS[c] for c in wanted] or [COUNTRY_IDS["US"]],
            "importance[]": [1, 2, 3],
            "dateFrom": ctx.start.isoformat(),
            "dateTo": ctx.end.isoformat(),
            "timeZone": self.timezone_id,
            "timeFilter": "timeRemain",
            "currentTab": "custom",
            "limit_from": 0,
        }
        raw = http_post(
            ENDPOINT,
            payload,
            headers={"X-Requested-With": "XMLHttpRequest", "Referer": REFERER,
                     "Accept": "application/json, text/javascript, */*; q=0.01"},
            timeout=self.timeout,
        )
        try:
            fragment = json.loads(raw).get("data", "")
        except json.JSONDecodeError as exc:
            raise FetchError("Investing.com の応答を解釈できませんでした") from exc

        parser = _RowParser()
        parser.feed(html.unescape(fragment) if "&lt;" in fragment[:200] else fragment)
        log.debug("investing: %s rows parsed", len(parser.rows))
        return self._to_events(ctx, parser.rows)

    # -- conversion ---------------------------------------------------------

    def _to_events(self, ctx: FetchContext, rows: list[dict]) -> list[EconEvent]:
        events: list[EconEvent] = []
        for row in rows:
            name = row["cells"]["event"]
            ind = ctx.catalog.match_name(name)
            if ind is None:
                continue
            start = self._parse_dt(row.get("datetime", ""))
            if start is None:
                continue
            local_day = start.astimezone(ctx.tz).date()
            if not ctx.start <= local_day <= ctx.end:
                continue
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
                    period=_period_from_name(name),
                    actual=_clean(row["cells"].get("actual")),
                    forecast=_clean(row["cells"].get("forecast")),
                    previous=_clean(row["cells"].get("previous")),
                    note=ind.why,
                    url=row.get("url") or ind.url,
                    extra={"raw_name": name},
                )
            )
        return events

    def _parse_dt(self, value: str) -> datetime | None:
        try:
            naive = datetime.strptime(value.strip(), "%Y/%m/%d %H:%M:%S")
        except ValueError:
            return None
        return naive.replace(tzinfo=self.assume_tz)


def _clean(value: str | None) -> str | None:
    value = (value or "").strip()
    return value if value and value not in {"&nbsp;", "-", "\xa0"} else None


def _period_from_name(name: str) -> str | None:
    """``CPI (YoY) (Aug)`` -> ``Aug``: the reference period the site appends."""
    match = re.search(r"\(([A-Z][a-z]{2}(?:/[A-Z][a-z]{2})?|Q[1-4])\)\s*$", name)
    return match.group(1) if match else None
