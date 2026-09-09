"""Configuration: defaults, YAML overlay, environment overrides."""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import yaml

DEFAULTS: dict[str, Any] = {
    # 表示・登録先
    "timezone": "Asia/Tokyo",
    "calendar": {
        "name": "経済指標 (Nasdaq)",
        "id": None,          # 明示指定。null なら name で検索し、無ければ作成
        "description": "ナスダックに影響する経済指標を自動同期しています。",
    },
    # 同期する期間
    "window": {"days_ahead": 60, "days_back": 5},
    # 選抜条件
    "filter": {
        "min_impact": 55,
        "countries": ["US", "JP", "EU", "CN"],
        "categories": [],       # 空 = 全カテゴリ
        "include": [],          # スコアに関係なく必ず入れる指標 id
        "exclude": [],          # 常に除外する指標 id
    },
    # データ取得元
    "providers": {
        "rules": True,
        "fomc": True,
        "market": True,
        "fred": {"enabled": "auto", "api_key_env": "FRED_API_KEY"},
        "investing": {"enabled": False, "timeout": 20},
        "earnings": {
            "enabled": True,
            "timeout": 20,
            "tickers": {
                "NVDA": 95, "AAPL": 88, "MSFT": 88, "GOOGL": 85,
                "AMZN": 85, "META": 84, "TSLA": 80, "AVGO": 80,
                "AMD": 72, "NFLX": 68, "TSM": 70, "MU": 62,
                "COST": 55, "ADBE": 55, "ORCL": 60, "PLTR": 55,
            },
        },
    },
    # 見た目
    "display": {
        "impact_stars": True,
        "impact_emoji": True,
        "show_country_flag": True,
        "show_score": False,
    },
    # 通知（分単位・イベント開始前）
    "reminders": {"S": [1440, 30], "A": [30], "B": [], "C": []},
    # Google カレンダーの色 ID
    "colors": {"S": "11", "A": "6", "B": "5", "C": "8"},
    # 週次ダイジェスト
    "digest": {
        "enabled": True,
        "weekly_event": True,
        "webhook_url_env": "ECON_CAL_WEBHOOK_URL",
    },
    # 認証
    "auth": {
        "client_secret_file": "credentials.json",
        "token_file": "token.json",
    },
}

#: ``ECON_CAL_<PATH>`` 形式の環境変数で上書きできる項目。
ENV_OVERRIDES = {
    "ECON_CAL_TIMEZONE": ("timezone",),
    "ECON_CAL_CALENDAR_ID": ("calendar", "id"),
    "ECON_CAL_CALENDAR_NAME": ("calendar", "name"),
    "ECON_CAL_MIN_IMPACT": ("filter", "min_impact"),
    "ECON_CAL_DAYS_AHEAD": ("window", "days_ahead"),
    "ECON_CAL_DAYS_BACK": ("window", "days_back"),
    "ECON_CAL_TOKEN_FILE": ("auth", "token_file"),
    "ECON_CAL_CLIENT_SECRET_FILE": ("auth", "client_secret_file"),
}

_INT_KEYS = {("filter", "min_impact"), ("window", "days_ahead"), ("window", "days_back")}

#: 通信を伴うプロバイダ。オフラインモードではまとめて無効化される。
NETWORK_PROVIDERS = frozenset({"fred", "investing", "earnings"})
OFFLINE_ENV = "ECON_CAL_OFFLINE"


def _deep_merge(base: dict, overlay: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in (overlay or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


class Config:
    """Dotted-path access over the merged configuration mapping."""

    def __init__(self, data: dict[str, Any], path: Path | None = None):
        self.data = data
        self.path = path
        self.validate()

    # -- construction -------------------------------------------------------

    @classmethod
    def load(cls, path: str | Path | None = None) -> Config:
        overlay: dict[str, Any] = {}
        resolved: Path | None = None
        if path:
            resolved = Path(path)
            if not resolved.exists():
                raise FileNotFoundError(f"設定ファイルが見つかりません: {resolved}")
        else:
            for candidate in (Path("config.yaml"), Path("config.yml")):
                if candidate.exists():
                    resolved = candidate
                    break
        if resolved:
            overlay = yaml.safe_load(resolved.read_text(encoding="utf-8")) or {}

        data = _deep_merge(DEFAULTS, overlay)
        for env_name, keys in ENV_OVERRIDES.items():
            raw = os.environ.get(env_name)
            if raw is None or raw == "":
                continue
            node = data
            for key in keys[:-1]:
                node = node[key]
            node[keys[-1]] = int(raw) if keys in _INT_KEYS else raw
        return cls(data, resolved)

    # -- access -------------------------------------------------------------

    def get(self, dotted: str, default: Any = None) -> Any:
        node: Any = self.data
        for key in dotted.split("."):
            if not isinstance(node, dict) or key not in node:
                return default
            node = node[key]
        return node

    def __getitem__(self, dotted: str) -> Any:
        return self.get(dotted)

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.data["timezone"])

    @property
    def offline(self) -> bool:
        return bool(os.environ.get(OFFLINE_ENV))

    def provider_enabled(self, name: str) -> bool:
        """``auto`` means "on when its credentials are present"."""
        if name in NETWORK_PROVIDERS and self.offline:
            return False
        node = self.get(f"providers.{name}")
        if isinstance(node, bool):
            return node
        if not isinstance(node, dict):
            return False
        flag = node.get("enabled", False)
        if flag == "auto":
            env = node.get("api_key_env")
            return bool(env and os.environ.get(env))
        return bool(flag)

    def reminders_for(self, tier: str) -> list[int]:
        return list(self.get(f"reminders.{tier}", []) or [])

    def color_for(self, tier: str) -> str | None:
        return self.get(f"colors.{tier}")

    # -- validation ---------------------------------------------------------

    def validate(self) -> None:
        try:
            ZoneInfo(self.data["timezone"])
        except (ZoneInfoNotFoundError, KeyError) as exc:
            raise ValueError(f"timezone が不正です: {self.data.get('timezone')!r}") from exc

        score = self.get("filter.min_impact")
        if not isinstance(score, int) or not 0 <= score <= 100:
            raise ValueError(f"filter.min_impact は 0-100 の整数: {score!r}")

        for key in ("window.days_ahead", "window.days_back"):
            value = self.get(key)
            if not isinstance(value, int) or value < 0:
                raise ValueError(f"{key} は 0 以上の整数: {value!r}")
        if self.get("window.days_ahead") > 400:
            raise ValueError("window.days_ahead は 400 日以内にしてください")

        for tier in ("S", "A", "B", "C"):
            for minutes in self.reminders_for(tier):
                if not isinstance(minutes, int) or not 0 <= minutes <= 40320:
                    raise ValueError(
                        f"reminders.{tier} は 0-40320 分の整数リスト: {minutes!r}"
                    )
