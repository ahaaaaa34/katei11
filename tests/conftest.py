import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from econ_cal.config import Config  # noqa: E402
from econ_cal.models import EconEvent  # noqa: E402

ET = ZoneInfo("America/New_York")
JST = ZoneInfo("Asia/Tokyo")


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    """テストが外部 API を叩かないようにする。"""
    monkeypatch.setenv("ECON_CAL_OFFLINE", "1")


@pytest.fixture
def config() -> Config:
    return Config.load(None)


def make_event(indicator_id="us_cpi", *, day=(2026, 9, 10), hour=8, minute=30, **kwargs):
    start = datetime(*day, hour, minute, tzinfo=kwargs.pop("tz", ET))
    return EconEvent(
        indicator_id=indicator_id,
        title=kwargs.pop("title", "テスト指標"),
        start=start,
        end=start + timedelta(minutes=30),
        impact=kwargs.pop("impact", 90),
        **kwargs,
    )
