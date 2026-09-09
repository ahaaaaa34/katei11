"""Central-bank meetings, derived from the curated ``meetings.yaml``.

Policy meeting dates are announced years in advance and never follow a
computable rule, so they are maintained by hand.  Everything hanging off a
meeting -- the press conference, the minutes three weeks later, the Beige Book
two weeks before -- is derived here rather than duplicated in the file.
"""

from __future__ import annotations

from datetime import date, timedelta

from ..catalog import load_meetings
from ..models import EconEvent
from ..schedule import at_local_time
from ..util import log
from .base import FetchContext

#: 議事要旨は会合2日目の3週間後、ベージュブックは会合の2週間前に公表される。
MINUTES_LAG = timedelta(days=21)
BEIGE_BOOK_LEAD = timedelta(days=14)

BANK_KEYS = {"fomc": ("us_fomc_rate", "us_fomc_presser"), "boj": ("jp_boj_decision", None),
             "ecb": ("eu_ecb_decision", None)}


class FomcProvider:
    name = "fomc"

    def __init__(self, meetings_path: str | None = None):
        self._path = meetings_path

    def fetch(self, ctx: FetchContext) -> list[EconEvent]:
        data = load_meetings(self._path)
        events: list[EconEvent] = []
        for bank, (rate_id, presser_id) in BANK_KEYS.items():
            section = data.get(bank) or {}
            meetings = section.get("meetings") or []
            if not meetings:
                continue
            self._warn_if_stale(bank, meetings, ctx.end, section.get("verify_url"))
            for meeting in meetings:
                events += self._expand(ctx, bank, meeting, rate_id, presser_id)
        return [e for e in events if ctx.start <= e.start.date() <= ctx.end]

    # -- helpers ------------------------------------------------------------

    def _warn_if_stale(self, bank: str, meetings: list[dict], end: date, url: str | None) -> None:
        last = max(m["date"] for m in meetings)
        if last < end:
            log.warning(
                "%s の会合日程が %s までしか登録されていません。"
                "econ_cal/data/meetings.yaml を更新してください (%s)",
                bank.upper(), last, url or "公式サイト参照",
            )

    def _expand(self, ctx, bank, meeting, rate_id, presser_id) -> list[EconEvent]:
        day: date = meeting["date"]
        sep = bool(meeting.get("sep"))
        out: list[EconEvent] = []

        rate = ctx.catalog.get(rate_id)
        if rate is None:
            return out

        note = rate.why
        if sep:
            note += (
                "\n【ドットチャート公表回】経済見通し(SEP)が同時発表される会合。"
                "利下げ回数の織り込みが一気に書き換わるため、通常会合より値動きが大きい。"
            )
        out.append(self._event(rate, day, impact=rate.impact, note=note,
                               extra={"sep": sep, "bank": bank}))

        if presser_id and (presser := ctx.catalog.get(presser_id)):
            bump = 2 if sep else 0
            out.append(self._event(presser, day, impact=min(100, presser.impact + bump),
                                   note=presser.why, extra={"sep": sep}))

        if bank == "fomc":
            if minutes := ctx.catalog.get("us_fomc_minutes"):
                out.append(self._event(minutes, day + MINUTES_LAG, impact=minutes.impact,
                                       note=minutes.why,
                                       period=f"{day.year}年{day.month}月{day.day}日会合分"))
            if beige := ctx.catalog.get("us_beige_book"):
                out.append(self._event(beige, day - BEIGE_BOOK_LEAD, impact=beige.impact,
                                       note=beige.why))
        return out

    def _event(self, ind, day: date, impact: int, note: str,
               period: str | None = None, extra: dict | None = None) -> EconEvent:
        start = at_local_time(day, ind.time, ind.zoneinfo)
        return EconEvent(
            indicator_id=ind.id,
            title=ind.name,
            start=start,
            end=start + timedelta(minutes=ind.duration),
            impact=impact,
            country=ind.country,
            category=ind.category,
            source=self.name,
            estimated=False,
            period=period,
            note=note,
            url=ind.url,
            extra=extra or {},
        )
