"""The diff engine: desired calendar state vs. what is already there."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any

from . import render
from .config import Config
from .gcal import MANAGED_KEY, MANAGED_VALUE, CalendarClient
from .models import EconEvent
from .util import log

MAX_REMINDERS = 5  # Google の上限


def to_google_body(event: EconEvent, config: Config) -> dict[str, Any]:
    """Render one event into a Calendar API resource."""
    tz = config.tz
    tz_name = config.get("timezone")

    if event.all_day:
        local_date = event.start.astimezone(tz).date()
        when = {
            "start": {"date": local_date.isoformat()},
            "end": {"date": (local_date + timedelta(days=1)).isoformat()},
        }
    else:
        when = {
            "start": {"dateTime": event.start.astimezone(tz).isoformat(), "timeZone": tz_name},
            "end": {"dateTime": event.end.astimezone(tz).isoformat(), "timeZone": tz_name},
        }

    reminders = config.reminders_for(event.tier)[:MAX_REMINDERS]
    body: dict[str, Any] = {
        "id": event.gcal_id(tz),
        "summary": render.title(event, config),
        "description": render.description(event, config),
        **when,
        # 指標は「予定」ではないので、空き時間検索を邪魔しないようにする。
        "transparency": "transparent",
        "reminders": {
            "useDefault": False,
            "overrides": [{"method": "popup", "minutes": m} for m in reminders],
        },
        "extendedProperties": {
            "private": {
                MANAGED_KEY: MANAGED_VALUE,
                "uid": event.uid(tz),
                "hash": event.content_hash(),
                "indicator": event.indicator_id,
                "impact": str(event.impact),
                "source": event.source,
            }
        },
    }
    if color := config.color_for(event.tier):
        body["colorId"] = str(color)
    if event.url and event.url.startswith("http"):
        body["source"] = {"title": event.title[:60], "url": event.url}
    return body


@dataclass
class SyncPlan:
    """What a sync would do, so ``--dry-run`` and the real run share a code path."""

    calendar_id: str
    created: list[tuple[EconEvent, dict]] = field(default_factory=list)
    updated: list[tuple[EconEvent, dict]] = field(default_factory=list)
    unchanged: list[EconEvent] = field(default_factory=list)
    deleted: list[dict] = field(default_factory=list)

    @property
    def changes(self) -> int:
        return len(self.created) + len(self.updated) + len(self.deleted)

    def summary(self) -> str:
        return (
            f"新規 {len(self.created)} / 更新 {len(self.updated)} / "
            f"削除 {len(self.deleted)} / 変更なし {len(self.unchanged)}"
        )


def build_plan(
    client: CalendarClient,
    config: Config,
    events: list[EconEvent],
    start: date,
    end: date,
) -> SyncPlan:
    """Compare the freshly collected events against the calendar's contents."""
    calendar_id = client.ensure_calendar()
    tz = config.tz

    time_min = datetime.combine(start, time.min, tzinfo=tz).isoformat()
    time_max = datetime.combine(end + timedelta(days=1), time.min, tzinfo=tz).isoformat()
    existing = {
        item["id"]: item
        for item in client.list_managed(calendar_id, time_min, time_max)
        if item.get("id")
    }

    plan = SyncPlan(calendar_id=calendar_id)
    seen: set[str] = set()

    for event in events:
        body = to_google_body(event, config)
        event_id = body["id"]
        seen.add(event_id)
        current = existing.get(event_id)
        if current is None:
            plan.created.append((event, body))
        elif _stored_hash(current) == event.content_hash():
            plan.unchanged.append(event)
        else:
            plan.updated.append((event, body))

    # Anything we previously wrote into this window that is no longer in the
    # selection: a rescheduled release, or a threshold the user tightened.
    plan.deleted = [item for event_id, item in existing.items() if event_id not in seen]
    return plan


def apply_plan(client: CalendarClient, plan: SyncPlan) -> SyncPlan:
    """Push the plan to Google.  Safe to re-run: every write is idempotent."""
    from googleapiclient.errors import HttpError

    for _, body in plan.created:
        try:
            client.insert(plan.calendar_id, body)
        except HttpError as exc:
            # 409 means the id exists but was outside the listed window (or was
            # soft-deleted); updating recycles it instead of failing the run.
            if getattr(exc.resp, "status", 0) == 409:
                client.update(plan.calendar_id, body["id"], body)
            else:
                log.error("作成に失敗: %s (%s)", body["summary"], exc)
                raise

    for _, body in plan.updated:
        client.update(plan.calendar_id, body["id"], body)

    for item in plan.deleted:
        client.delete(plan.calendar_id, item["id"])

    log.info("同期完了: %s", plan.summary())
    return plan


def _stored_hash(item: dict) -> str | None:
    return ((item.get("extendedProperties") or {}).get("private") or {}).get("hash")
