"""Market-structure events computed locally: closures, half-days, expiries.

None of these are "economic indicators", but they change how the Nasdaq trades
on a given day, so they belong on the same calendar.  All of them follow fixed
exchange rules, which means no network call is needed.
"""

from __future__ import annotations

from datetime import datetime, time, timedelta

from ..models import EconEvent
from ..schedule import (
    ET,
    WEEKDAYS,
    _nth_weekday,
    at_local_time,
    market_early_closes,
    market_holidays,
)
from .base import FetchContext

QUARTER_MONTHS = (3, 6, 9, 12)


class MarketProvider:
    name = "market"

    def fetch(self, ctx: FetchContext) -> list[EconEvent]:
        events: list[EconEvent] = []
        for year in range(ctx.start.year, ctx.end.year + 1):
            events += self._closures(ctx, year)
            events += self._expiries(ctx, year)
            events += self._rebalances(ctx, year)
        return [e for e in events if ctx.start <= e.start.astimezone(ctx.tz).date() <= ctx.end]

    # -- pieces -------------------------------------------------------------

    def _closures(self, ctx: FetchContext, year: int) -> list[EconEvent]:
        out: list[EconEvent] = []
        holiday = ctx.catalog.get("market_holiday")
        early = ctx.catalog.get("market_early_close")

        if holiday:
            for day, name in market_holidays(year).items():
                # All-day events are anchored in the *display* timezone so the
                # date shown to the user is the US date, whatever their offset.
                start = datetime.combine(day, time(0, 0), tzinfo=ctx.tz)
                out.append(
                    EconEvent(
                        indicator_id=holiday.id,
                        title=f"{holiday.name} ({name})",
                        start=start,
                        end=start + timedelta(days=1),
                        impact=holiday.impact,
                        country=holiday.country,
                        category=holiday.category,
                        source=self.name,
                        all_day=True,
                        note=f"{name} のため NYSE・ナスダックは終日休場。\n{holiday.why}",
                    )
                )

        if early:
            for day, name in market_early_closes(year).items():
                start = at_local_time(day, early.time, ET)
                out.append(
                    EconEvent(
                        indicator_id=early.id,
                        title=f"{early.name} ({name})",
                        start=start,
                        end=start + timedelta(minutes=early.duration),
                        impact=early.impact,
                        country=early.country,
                        category=early.category,
                        source=self.name,
                        note=f"{name} のため 13:00 ET で取引終了。\n{early.why}",
                    )
                )
        return out

    def _expiries(self, ctx: FetchContext, year: int) -> list[EconEvent]:
        out: list[EconEvent] = []
        for month in range(1, 13):
            third_friday = _nth_weekday(year, month, WEEKDAYS["fri"], 3)
            quad = month in QUARTER_MONTHS
            ind = ctx.catalog.get("market_quad_witching" if quad else "market_opex")
            if ind is None:
                continue
            start = at_local_time(third_friday, ind.time, ET)
            note = ind.why
            if quad:
                note += "\n同日に S&P500 の四半期リバランスも執行され、引けの出来高が跳ね上がる。"
            out.append(
                EconEvent(
                    indicator_id=ind.id,
                    title=ind.name,
                    start=start,
                    end=start + timedelta(minutes=ind.duration),
                    impact=ind.impact,
                    country=ind.country,
                    category=ind.category,
                    source=self.name,
                    note=note,
                )
            )
        return out

    def _rebalances(self, ctx: FetchContext, year: int) -> list[EconEvent]:
        """Nasdaq-100 annual reconstitution: announced after the close on the
        second Friday of December, effective before the open after the third."""
        ind = ctx.catalog.get("market_index_rebalance")
        if ind is None:
            return []
        announce = _nth_weekday(year, 12, WEEKDAYS["fri"], 2)
        start = at_local_time(announce, ind.time, ET)
        return [
            EconEvent(
                indicator_id=ind.id,
                title="Nasdaq-100 年次銘柄入替 発表",
                start=start,
                end=start + timedelta(minutes=ind.duration),
                impact=ind.impact,
                country=ind.country,
                category=ind.category,
                source=self.name,
                note=(
                    "引け後に構成銘柄の入替が発表される。翌週の第3金曜の引けで"
                    "パッシブ資金が執行され、対象銘柄は前後で大きく動く。\n" + ind.why
                ),
            )
        ]
