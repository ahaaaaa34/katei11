"""放置運用のための自己点検。

無人で回すツールの最大の failure mode は「静かに古くなること」なので、
手当てが必要になった時点で**外から見える形で**知らせる必要がある。
ここで検出したものを doctor が表示し、CI が Issue と Webhook に流す。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from .catalog import load_catalog, load_meetings
from .collect import window_dates
from .config import Config

#: 同期範囲の先端からこの日数だけ先まで会合日程が埋まっていることを求める。
#: 切れる前に気づいて手当てするための猶予。
MEETING_HEADROOM = timedelta(days=90)

ACTION = "action"  # 人が手を動かす必要がある
INFO = "info"      # 設定すればもっと良くなる、程度


@dataclass(frozen=True)
class Finding:
    key: str
    severity: str
    message: str
    fix: str

    def render(self) -> str:
        return f"{self.message}\n    → {self.fix}"


def maintenance_report(config: Config, today: date | None = None) -> list[Finding]:
    """今すぐ、あるいは近いうちに人手が要るものを列挙する。"""
    today = today or date.today()
    _, window_end = window_dates(config, today)
    deadline = window_end + MEETING_HEADROOM
    findings: list[Finding] = []

    meetings = load_meetings()
    for bank, label in (("fomc", "FOMC"), ("boj", "日銀"), ("ecb", "ECB")):
        section = meetings.get(bank) or {}
        entries = section.get("meetings") or []
        url = section.get("verify_url", "")
        if not entries:
            # 未登録は既定の状態なので、FOMC 以外は騒がない。
            if bank == "fomc":
                findings.append(
                    Finding(
                        key=f"meetings:{bank}",
                        severity=ACTION,
                        message=f"{label} の会合日程が1件も登録されていません。",
                        fix=f"{url} を見て econ_cal/data/meetings.yaml に追記してください。",
                    )
                )
            continue

        last = max(entry["date"] for entry in entries)
        if last < deadline:
            days = (last - today).days
            severity = ACTION if last < window_end else INFO
            when = f"あと {days} 日" if days >= 0 else f"{-days} 日前に期限切れ"
            findings.append(
                Finding(
                    key=f"meetings:{bank}",
                    severity=severity,
                    message=(
                        f"{label} の会合日程が {last} で切れます"
                        f"（{when} / 同期範囲の末尾は {window_end}）。"
                    ),
                    fix=f"{url} を見て econ_cal/data/meetings.yaml に翌年分を追記してください。",
                )
            )

    if not config.provider_enabled("fred") and not config.offline:
        findings.append(
            Finding(
                key="provider:fred",
                severity=INFO,
                message="FRED が無効なため、発表日の一部が推定のままです。",
                fix=(
                    "https://fred.stlouisfed.org/docs/api/api_key.html で無料キーを取得し、"
                    "FRED_API_KEY（CI ならリポジトリの Secret）に設定してください。"
                ),
            )
        )

    if len(load_catalog()) == 0:  # pragma: no cover - カタログが壊れた時の保険
        findings.append(
            Finding(
                key="catalog:empty",
                severity=ACTION,
                message="指標カタログが空です。",
                fix="econ_cal/data/indicators.yaml を確認してください。",
            )
        )
    return findings


def needs_action(findings: list[Finding]) -> bool:
    return any(f.severity == ACTION for f in findings)


def as_text(findings: list[Finding]) -> str:
    """Issue 本文や Webhook にそのまま流せる形にする。"""
    if not findings:
        return "手当てが必要な項目はありません。"
    lines = []
    for finding in findings:
        marker = "❗" if finding.severity == ACTION else "・"
        lines.append(f"{marker} {finding.render()}")
    return "\n".join(lines)
