"""複数ソースの突き合わせと選抜フィルタ。"""

from datetime import date

from econ_cal.collect import apply_filter, collect, drop_superseded_estimates, merge, window_dates
from econ_cal.config import Config
from econ_cal.util import FetchError

from .conftest import JST, make_event


class FakeProvider:
    def __init__(self, name, events):
        self.name = name
        self._events = events

    def fetch(self, ctx):
        return list(self._events)


class BrokenProvider:
    name = "broken"

    def fetch(self, ctx):
        raise FetchError("upstream down")


class ExplodingProvider:
    name = "exploding"

    def fetch(self, ctx):
        raise RuntimeError("bug in provider")


def test_merge_collapses_the_same_release(config):
    events = [
        make_event(source="rules", estimated=True),
        make_event(source="fred", forecast=None),
        make_event(source="investing", forecast="0.3%"),
    ]
    merged = merge(events, JST)
    assert len(merged) == 1
    assert merged[0].source == "fred"
    assert merged[0].forecast == "0.3%"


def test_estimate_is_dropped_when_a_confirmed_date_appears_nearby():
    guess = make_event(day=(2026, 9, 14), source="rules", estimated=True)
    confirmed = make_event(day=(2026, 9, 11), source="fred", estimated=False)
    kept = drop_superseded_estimates([guess, confirmed], JST)
    assert [e.start.day for e in kept] == [11]


def test_a_distant_confirmed_date_does_not_drop_the_estimate():
    """月をまたぐ同一指標は別の発表なので、両方残さなければならない。"""
    guess = make_event(day=(2026, 10, 14), source="rules", estimated=True)
    confirmed = make_event(day=(2026, 9, 11), source="fred", estimated=False)
    kept = drop_superseded_estimates([guess, confirmed], JST)
    assert len(kept) == 2


def test_weekly_releases_are_never_superseded():
    """毎週の指標は exact なので推定フラグが立たず、間引かれない。"""
    weekly = [
        make_event("us_jobless_claims", day=(2026, 9, d), estimated=False) for d in (3, 10, 17)
    ]
    assert len(drop_superseded_estimates(weekly, JST)) == 3


def test_filter_applies_the_impact_threshold(config):
    events = [make_event(impact=95), make_event("us_low", impact=40)]
    assert [e.impact for e in apply_filter(events, config)] == [95]


def test_filter_include_overrides_the_threshold(config):
    config.data["filter"]["include"] = ["us_low"]
    events = [make_event("us_low", impact=10)]
    assert len(apply_filter(events, config)) == 1


def test_filter_exclude_beats_include(config):
    config.data["filter"]["include"] = ["us_cpi"]
    config.data["filter"]["exclude"] = ["us_cpi"]
    assert apply_filter([make_event("us_cpi", impact=98)], config) == []


def test_filter_by_country_and_category(config):
    config.data["filter"]["countries"] = ["US"]
    config.data["filter"]["categories"] = ["inflation"]
    events = [
        make_event("a", impact=90, country="US", category="inflation"),
        make_event("b", impact=90, country="JP", category="inflation"),
        make_event("c", impact=90, country="US", category="housing"),
    ]
    assert [e.indicator_id for e in apply_filter(events, config)] == ["a"]


def test_a_broken_provider_does_not_abort_the_run(config):
    events = collect(
        config,
        date(2026, 9, 1),
        date(2026, 9, 30),
        providers=[BrokenProvider(), FakeProvider("rules", [make_event(impact=95)])],
    )
    assert len(events) == 1


def test_an_unexpected_provider_bug_is_contained(config):
    events = collect(
        config,
        date(2026, 9, 1),
        date(2026, 9, 30),
        providers=[ExplodingProvider(), FakeProvider("rules", [make_event(impact=95)])],
    )
    assert len(events) == 1


def test_results_are_sorted_by_time_then_impact(config):
    events = collect(
        config,
        date(2026, 9, 1),
        date(2026, 9, 30),
        providers=[
            FakeProvider(
                "rules",
                [
                    make_event("b", day=(2026, 9, 10), hour=8, impact=80),
                    make_event("a", day=(2026, 9, 10), hour=8, impact=95),
                    make_event("c", day=(2026, 9, 9), hour=8, impact=60),
                ],
            )
        ],
    )
    assert [e.indicator_id for e in events] == ["c", "a", "b"]


def test_offline_defaults_produce_a_full_month(config):
    """キーも通信も無い状態で実用的な件数が出ることを保証する。"""
    config.data["providers"]["earnings"]["enabled"] = False
    events = collect(config, date(2026, 9, 1), date(2026, 9, 30))
    ids = {e.indicator_id for e in events}
    assert {"us_cpi", "us_nfp", "us_fomc_rate", "us_ism_mfg"} <= ids
    assert len(events) >= 20


def test_window_dates_span_the_configured_range():
    config = Config.load(None)
    config.data["window"] = {"days_back": 3, "days_ahead": 30}
    start, end = window_dates(config, today=date(2026, 9, 9))
    assert (start, end) == (date(2026, 9, 6), date(2026, 10, 9))
