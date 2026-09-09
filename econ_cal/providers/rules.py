"""Offline provider: expands the catalog's recurrence rules into events.

This is the baseline source.  It needs no API key and no network, so the tool
always produces a usable calendar; the networked providers then confirm exact
dates and attach consensus figures on top of it.
"""

from __future__ import annotations

from datetime import timedelta

from ..models import EconEvent
from ..schedule import at_local_time, rule_dates
from .base import FetchContext


def _period_label(year: int, month: int, offset: int) -> str | None:
    if offset == 0:
        return None
    month_index = month - 1 + offset
    return f"{year + month_index // 12}年{month_index % 12 + 1}月分"


class RulesProvider:
    name = "rules"

    def fetch(self, ctx: FetchContext) -> list[EconEvent]:
        events: list[EconEvent] = []
        # Expand a month either side so a rule landing just outside the window
        # still gets clipped correctly rather than dropped.
        pad_start = ctx.start - timedelta(days=31)
        pad_end = ctx.end + timedelta(days=31)

        for ind in ctx.catalog.with_rules():
            for day in rule_dates(ind.schedule, pad_start, pad_end):
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
                        estimated=not ind.rule_is_exact,
                        period=_period_label(day.year, day.month, ind.period_offset),
                        note=ind.why,
                        url=ind.url,
                    )
                )
        return events
