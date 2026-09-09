"""Turning an :class:`EconEvent` into what the user actually sees."""

from __future__ import annotations

from zoneinfo import ZoneInfo

from .config import Config
from .models import EconEvent
from .schedule import ET

TIER_EMOJI = {"S": "🔴", "A": "🟠", "B": "🟡", "C": "⚪"}
TIER_LABEL = {"S": "最重要", "A": "重要", "B": "注目", "C": "参考"}
FLAGS = {"US": "🇺🇸", "JP": "🇯🇵", "EU": "🇪🇺", "CN": "🇨🇳", "GB": "🇬🇧", "DE": "🇩🇪"}
WEEKDAY_JA = "月火水木金土日"

CATEGORY_LABEL = {
    "fed": "金融政策",
    "inflation": "物価",
    "labor": "雇用",
    "growth": "景気",
    "sentiment": "景況感",
    "housing": "住宅",
    "trade": "貿易",
    "rates": "金利・債券",
    "market": "市場イベント",
    "earnings": "決算",
    "other": "その他",
}

MARKER = "econ-calendar"


def stars(impact: int) -> str:
    filled = max(1, min(5, round(impact / 20)))
    return "★" * filled + "☆" * (5 - filled)


def title(event: EconEvent, config: Config) -> str:
    parts: list[str] = []
    if config.get("display.impact_emoji", True):
        parts.append(TIER_EMOJI[event.tier])
    if config.get("display.show_country_flag", True) and event.country in FLAGS:
        parts.append(FLAGS[event.country])
    parts.append(event.title)
    if config.get("display.show_score", False):
        parts.append(f"[{event.impact}]")
    if event.actual:
        parts.append(f"→ {event.actual}")
    elif event.estimated:
        parts.append("(予定日未確定)")
    return " ".join(parts)


def _clock(event: EconEvent, tz: ZoneInfo) -> str:
    """Local time plus the New York time, since that is how it gets quoted."""
    local = event.start.astimezone(tz)
    weekday = WEEKDAY_JA[local.weekday()]
    line = f"{local:%Y/%m/%d}({weekday}) {local:%H:%M}"
    if event.all_day:
        return f"{local:%Y/%m/%d}({weekday}) 終日"
    eastern = event.start.astimezone(ET)
    return f"{line}  (現地 {eastern:%H:%M} ET)"


def description(event: EconEvent, config: Config) -> str:
    tz = config.tz
    lines: list[str] = [
        f"影響度  {stars(event.impact)}  {event.impact}/100 "
        f"（{event.tier}ランク・{TIER_LABEL[event.tier]}）",
        f"分類    {CATEGORY_LABEL.get(event.category, event.category)}",
        f"日時    {_clock(event, tz)}",
    ]
    if event.period:
        lines.append(f"対象期間 {event.period}")

    reported = (("予想", event.forecast), ("前回", event.previous), ("結果", event.actual))
    figures = [(label, value) for label, value in reported if value]
    if figures:
        lines.append("")
        lines += [f"　{label}  {value}" for label, value in figures]

    if event.note:
        lines += ["", "── ナスダックへの効き方 ──", event.note.strip()]

    footer = [""]
    if event.estimated:
        footer.append(
            "⚠️ この日付は過去の慣例から推定したものです。"
            "公式発表で前後する可能性があります。"
        )
    if event.url:
        footer.append(f"🔗 {event.url}")
    footer.append(f"情報源: {event.source} / 自動同期: {MARKER}")
    return "\n".join(lines + footer)


def one_line(event: EconEvent, config: Config) -> str:
    """Compact row for the terminal preview and the digest."""
    local = event.start.astimezone(config.tz)
    when = f"{local:%m/%d}({WEEKDAY_JA[local.weekday()]}) " + (
        "終日  " if event.all_day else f"{local:%H:%M}"
    )
    flag = FLAGS.get(event.country, "  ")
    mark = "~" if event.estimated else " "
    figures = ""
    if event.actual:
        figures = f"  結果 {event.actual}" + (f" / 予想 {event.forecast}" if event.forecast else "")
    elif event.forecast:
        figures = f"  予想 {event.forecast}"
    return f"{when} {TIER_EMOJI[event.tier]}{flag} {event.title}{mark}{figures}"
