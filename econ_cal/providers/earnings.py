"""Megacap earnings from Nasdaq's public calendar endpoint.

Not an economic indicator, but for the Nasdaq-100 a single NVDA or AAPL print
moves the index more than most macro releases, so the calendar is incomplete
without them.  Only the tickers configured under ``providers.earnings.tickers``
are kept -- the endpoint returns hundreds of names per day.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta

from ..models import EconEvent
from ..schedule import ET, federal_holidays
from ..util import FetchError, cached_json, http_json, log
from .base import FetchContext

ENDPOINT = "https://api.nasdaq.com/api/calendar/earnings"
CACHE_TTL = 6 * 3600

#: 発表タイミング → おおよその時刻 (ET)。引け後が圧倒的に多い。
SESSION_TIMES = {
    "time-pre-market": (time(7, 0), "寄り前"),
    "time-after-hours": (time(16, 15), "引け後"),
    "time-not-supplied": (time(16, 15), "時刻未定"),
}


class EarningsProvider:
    name = "earnings"

    def __init__(self, tickers: dict[str, int] | None = None, timeout: int = 20):
        self.tickers = {k.upper(): int(v) for k, v in (tickers or {}).items()}
        self.timeout = timeout

    def fetch(self, ctx: FetchContext) -> list[EconEvent]:
        if not self.tickers:
            return []
        events: list[EconEvent] = []
        failures = 0
        for day in _trading_days(ctx.start, ctx.end):
            try:
                rows = self._day(day)
            except FetchError as exc:
                failures += 1
                log.debug("earnings: %s の取得に失敗 (%s)", day, exc)
                if failures >= 3:
                    raise FetchError(
                        "Nasdaq の決算カレンダーに繰り返し接続できませんでした"
                    ) from exc
                continue
            events += [e for e in (self._to_event(day, row) for row in rows) if e]
        return events

    # -- api ----------------------------------------------------------------

    def _day(self, day: date) -> list[dict]:
        def produce() -> list[dict]:
            payload = http_json(
                ENDPOINT,
                params={"date": day.isoformat()},
                headers={"Accept": "application/json"},
                timeout=self.timeout,
            )
            data = payload.get("data") or {}
            return data.get("rows") or []

        return cached_json(f"nasdaq:earnings:{day}", CACHE_TTL, produce)

    def _to_event(self, day: date, row: dict) -> EconEvent | None:
        symbol = (row.get("symbol") or "").strip().upper()
        impact = self.tickers.get(symbol)
        if impact is None:
            return None

        slot, label = SESSION_TIMES.get(row.get("time", ""), SESSION_TIMES["time-not-supplied"])
        start = datetime.combine(day, slot, tzinfo=ET)
        company = (row.get("name") or symbol).strip()
        estimate = (row.get("epsForecast") or "").strip()
        quarter = (row.get("fiscalQuarterEnding") or "").strip()

        return EconEvent(
            indicator_id=f"earnings_{symbol}",
            title=f"{symbol} 決算発表 ({label})",
            start=start,
            end=start + timedelta(minutes=30),
            impact=impact,
            country="US",
            category="earnings",
            source=self.name,
            estimated=row.get("time") == "time-not-supplied",
            period=quarter or None,
            forecast=f"EPS予想 {estimate}" if estimate else None,
            note=(
                f"{company} の四半期決算。\n"
                "ナスダック100の時価総額上位銘柄の決算は、指数そのものを動かす。"
                "特にガイダンスと設備投資計画が半導体・AI関連セクター全体に波及する。"
            ),
            url=f"https://www.nasdaq.com/market-activity/stocks/{symbol.lower()}/earnings",
            extra={"symbol": symbol},
        )


def _trading_days(start: date, end: date):
    day = start
    while day <= end:
        if day.weekday() < 5 and day not in federal_holidays(day.year):
            yield day
        day += timedelta(days=1)
