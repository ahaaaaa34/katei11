"""Run the providers, reconcile their results, apply the selection filter."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from zoneinfo import ZoneInfo

from .catalog import Catalog, load_catalog
from .config import Config
from .models import EconEvent
from .providers import FetchContext, Provider, build_providers
from .util import FetchError, log

#: 推定日と確定日がこの日数以内なら「同じ発表」とみなし、推定側を捨てる。
SUPERSEDE_WINDOW = timedelta(days=12)


def window_dates(config: Config, today: date | None = None) -> tuple[date, date]:
    today = today or date.today()
    return (
        today - timedelta(days=config.get("window.days_back", 5)),
        today + timedelta(days=config.get("window.days_ahead", 60)),
    )


def collect(
    config: Config,
    start: date,
    end: date,
    catalog: Catalog | None = None,
    providers: list[Provider] | None = None,
) -> list[EconEvent]:
    """Fetch from every enabled source and return the selected event list.

    A provider that cannot reach its upstream is logged and skipped: one dead
    source must never take the whole sync down, because the offline rule engine
    alone still yields a useful calendar.
    """
    catalog = catalog or load_catalog()
    ctx = FetchContext(start=start, end=end, catalog=catalog, config=config, tz=config.tz)
    providers = build_providers(config) if providers is None else providers

    raw: list[EconEvent] = []
    for provider in providers:
        try:
            found = provider.fetch(ctx)
        except FetchError as exc:
            log.warning("プロバイダ %s をスキップします: %s", provider.name, exc)
            continue
        except Exception as exc:  # noqa: BLE001 - a provider bug must not abort the sync
            log.warning("プロバイダ %s で予期しないエラー: %s", provider.name, exc)
            continue
        log.info("%-10s %3d 件", provider.name, len(found))
        raw += found

    merged = merge(raw, config.tz)
    merged = drop_superseded_estimates(merged, config.tz)
    selected = apply_filter(merged, config)
    return sorted(selected, key=lambda e: (e.start, -e.impact, e.indicator_id))


def merge(events: list[EconEvent], tz: ZoneInfo) -> list[EconEvent]:
    """Collapse events that describe the same release on the same local day."""
    by_uid: dict[str, EconEvent] = {}
    for event in events:
        key = event.uid(tz)
        existing = by_uid.get(key)
        by_uid[key] = event if existing is None else existing.merged_with(event)
    return list(by_uid.values())


def drop_superseded_estimates(events: list[EconEvent], tz: ZoneInfo) -> list[EconEvent]:
    """Remove a guessed date once a real one turns up nearby.

    The rule engine places CPI on the 12th; FRED then says the 11th.  Both are
    the same release, but they land on different days and so survive :func:`merge`
    as separate events -- this is what stops the duplicate from reaching the
    calendar.
    """
    confirmed: dict[str, list[date]] = defaultdict(list)
    for event in events:
        if not event.estimated:
            confirmed[event.indicator_id].append(event.start.astimezone(tz).date())

    out: list[EconEvent] = []
    for event in events:
        if event.estimated:
            day = event.start.astimezone(tz).date()
            if any(abs(day - c) <= SUPERSEDE_WINDOW for c in confirmed[event.indicator_id]):
                continue
        out.append(event)
    return out


def apply_filter(events: list[EconEvent], config: Config) -> list[EconEvent]:
    """Apply the Nasdaq-relevance selection rules from the config."""
    min_impact = config.get("filter.min_impact", 55)
    countries = set(config.get("filter.countries") or [])
    categories = set(config.get("filter.categories") or [])
    include = set(config.get("filter.include") or [])
    exclude = set(config.get("filter.exclude") or [])

    out: list[EconEvent] = []
    for event in events:
        if event.indicator_id in exclude:
            continue
        if event.indicator_id in include:
            out.append(event)
            continue
        if countries and event.country not in countries:
            continue
        if categories and event.category not in categories:
            continue
        if event.impact < min_impact:
            continue
        out.append(event)
    return out
