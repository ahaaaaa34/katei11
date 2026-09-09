"""各プロバイダの変換ロジック。ネットワークは全てスタブに差し替える。"""

from datetime import date
from zoneinfo import ZoneInfo

import pytest

from econ_cal.catalog import load_catalog
from econ_cal.providers import earnings as earnings_mod
from econ_cal.providers import fred as fred_mod
from econ_cal.providers.base import FetchContext
from econ_cal.providers.earnings import EarningsProvider
from econ_cal.providers.fomc import FomcProvider
from econ_cal.providers.fred import FredProvider
from econ_cal.providers.investing import InvestingProvider, _period_from_name, _RowParser
from econ_cal.providers.market import MarketProvider
from econ_cal.providers.rules import RulesProvider
from econ_cal.util import FetchError

JST = ZoneInfo("Asia/Tokyo")


@pytest.fixture
def ctx(config):
    return FetchContext(
        start=date(2026, 9, 1), end=date(2026, 9, 30),
        catalog=load_catalog(), config=config, tz=JST,
    )


# --- rules -----------------------------------------------------------------

def test_rules_produce_the_expected_headline_releases(ctx):
    events = {e.indicator_id: e for e in RulesProvider().fetch(ctx)}
    assert events["us_ism_mfg"].start.date() == date(2026, 9, 1)
    assert events["us_nfp"].start.date() == date(2026, 9, 4)


def test_rules_flag_approximate_dates(ctx):
    events = {e.indicator_id: e for e in RulesProvider().fetch(ctx)}
    assert events["us_ism_mfg"].estimated is False   # 第1営業日は確定ルール
    assert events["us_cpi"].estimated is True        # 日付は概算


def test_rules_label_the_reference_period(ctx):
    cpi = next(e for e in RulesProvider().fetch(ctx) if e.indicator_id == "us_cpi")
    assert cpi.period == "2026年8月分"


def test_rules_stay_inside_the_window(ctx):
    assert all(ctx.start <= e.start.date() <= ctx.end for e in RulesProvider().fetch(ctx))


# --- fomc ------------------------------------------------------------------

def test_fomc_expands_a_meeting_into_its_satellites(ctx):
    ids = {e.indicator_id for e in FomcProvider().fetch(ctx)}
    assert "us_fomc_rate" in ids and "us_fomc_presser" in ids


def test_fomc_minutes_land_three_weeks_later(config):
    ctx = FetchContext(date(2026, 10, 1), date(2026, 10, 31), load_catalog(), config, JST)
    minutes = next(e for e in FomcProvider().fetch(ctx) if e.indicator_id == "us_fomc_minutes")
    assert minutes.start.date() == date(2026, 10, 7)  # 9/16 の 21 日後
    assert "9月16日会合分" in minutes.period


def test_sep_meetings_are_annotated(ctx):
    rate = next(e for e in FomcProvider().fetch(ctx) if e.indicator_id == "us_fomc_rate")
    assert rate.extra["sep"] is True
    assert "ドットチャート" in rate.note


def test_fomc_events_are_never_estimated(ctx):
    assert all(e.estimated is False for e in FomcProvider().fetch(ctx))


# --- market ----------------------------------------------------------------

def test_market_holidays_are_all_day(config):
    ctx = FetchContext(date(2026, 9, 1), date(2026, 9, 30), load_catalog(), config, JST)
    holiday = next(e for e in MarketProvider().fetch(ctx) if e.indicator_id == "market_holiday")
    assert holiday.all_day and "レイバーデー" in holiday.title


def test_quad_witching_only_in_quarter_end_months(config):
    ctx = FetchContext(date(2026, 1, 1), date(2026, 12, 31), load_catalog(), config, JST)
    events = MarketProvider().fetch(ctx)
    quads = [e for e in events if e.indicator_id == "market_quad_witching"]
    assert sorted({e.start.month for e in quads}) == [3, 6, 9, 12]
    assert len([e for e in events if e.indicator_id == "market_opex"]) == 8


# --- fred ------------------------------------------------------------------

def test_fred_needs_an_api_key(ctx):
    with pytest.raises(FetchError, match="API キー"):
        FredProvider(api_key="").fetch(ctx)


def test_fred_maps_release_names_onto_indicators(ctx, monkeypatch):
    monkeypatch.setattr(
        fred_mod, "http_json",
        lambda url, **kw: {
            "count": 2,
            "release_dates": [
                {"release_id": 10, "release_name": "Consumer Price Index", "date": "2026-09-11"},
                {"release_id": 99, "release_name": "Cheese Price Index", "date": "2026-09-11"},
            ],
        },
    )
    events = FredProvider(api_key="dummy").fetch(ctx)
    assert [e.indicator_id for e in events] == ["us_cpi"]
    cpi = events[0]
    assert cpi.start.date() == date(2026, 9, 11)
    assert cpi.estimated is False           # 公式日付なので推定ではない
    assert cpi.start.strftime("%H:%M") == "08:30"  # 時刻はカタログから


def test_fred_ignores_dates_outside_the_window(ctx, monkeypatch):
    monkeypatch.setattr(
        fred_mod, "http_json",
        lambda url, **kw: {
            "count": 1,
            "release_dates": [
                {"release_id": 10, "release_name": "Consumer Price Index", "date": "2027-01-11"}
            ],
        },
    )
    assert FredProvider(api_key="dummy").fetch(ctx) == []


# --- investing -------------------------------------------------------------

# ruff: noqa: E501 (実際の HTML 断片をそのまま使う)
ROW = """<tr id="eventRowId_733" data-event-datetime="2026/09/11 12:30:00">
<td class="first left time js-time">12:30</td>
<td class="left flagCur noWrap"><span class="ceFlags United_States"></span>&nbsp;USD</td>
<td class="left textNum sentiment noWrap" title="High Volatility Expected" data-img_key="bull3"></td>
<td class="left event"><a href="/economic-calendar/cpi-733">Core CPI (MoM)&nbsp;<span>(Aug)</span></a></td>
<td class="bold greenFont" id="eventActual_733">0.2%</td>
<td id="eventForecast_733">0.3%</td>
<td id="eventPrevious_733">0.4%</td></tr>"""


def test_investing_row_parser_extracts_the_figures():
    parser = _RowParser()
    parser.feed(ROW)
    cells = parser.rows[0]["cells"]
    assert cells["actual"] == "0.2%"
    assert cells["forecast"] == "0.3%"
    assert cells["previous"] == "0.4%"
    assert parser.rows[0]["importance"] == "3"


def test_investing_parser_survives_unexpected_markup():
    parser = _RowParser()
    parser.feed("<tr><td class='weird'><div>???</div></td></tr>" + ROW)
    assert len(parser.rows) == 1  # 壊れた行は落ちるだけで例外にならない


def test_investing_converts_rows_into_events(ctx):
    parser = _RowParser()
    parser.feed(ROW)
    provider = InvestingProvider(assume_tz="UTC")
    events = provider._to_events(ctx, parser.rows)
    assert len(events) == 1
    event = events[0]
    assert event.indicator_id == "us_cpi"
    assert (event.forecast, event.previous, event.actual) == ("0.3%", "0.4%", "0.2%")
    assert event.start.astimezone(ctx.tz).date() == date(2026, 9, 11)


def test_investing_skips_events_that_are_not_in_the_catalog(ctx):
    rows = [{"datetime": "2026/09/11 12:30:00", "cells": {"event": "Latvian Tractor Output"}}]
    assert InvestingProvider()._to_events(ctx, rows) == []


@pytest.mark.parametrize(
    "name,expected", [("CPI (YoY) (Aug)", "Aug"), ("GDP (QoQ) (Q2)", "Q2"), ("CPI (MoM)", None)]
)
def test_period_extraction(name, expected):
    assert _period_from_name(name) == expected


# --- earnings --------------------------------------------------------------

def test_earnings_keeps_only_configured_tickers(ctx, monkeypatch):
    rows = [
        {"symbol": "NVDA", "name": "NVIDIA", "time": "time-after-hours", "epsForecast": "$1.42"},
        {"symbol": "XYZ", "name": "Nobody", "time": "time-pre-market", "epsForecast": "$0.01"},
    ]
    monkeypatch.setattr(earnings_mod, "cached_json", lambda key, ttl, produce: rows)
    events = EarningsProvider({"NVDA": 95}).fetch(ctx)
    assert {e.extra["symbol"] for e in events} == {"NVDA"}
    assert events[0].impact == 95


def test_earnings_maps_the_session_to_a_time():
    provider = EarningsProvider({"AAPL": 88})
    after = provider._to_event(date(2026, 10, 29), {"symbol": "AAPL", "time": "time-after-hours"})
    before = provider._to_event(date(2026, 10, 29), {"symbol": "AAPL", "time": "time-pre-market"})
    assert after.start.hour == 16 and "引け後" in after.title
    assert before.start.hour == 7 and "寄り前" in before.title


def test_earnings_without_tickers_does_nothing(ctx):
    assert EarningsProvider({}).fetch(ctx) == []


def test_earnings_gives_up_after_repeated_failures(ctx, monkeypatch):
    def boom(key, ttl, produce):
        raise FetchError("down")

    monkeypatch.setattr(earnings_mod, "cached_json", boom)
    with pytest.raises(FetchError, match="繰り返し接続できません"):
        EarningsProvider({"NVDA": 95}).fetch(ctx)
