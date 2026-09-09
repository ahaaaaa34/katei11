"""イベントの同一性判定とソース合成の検証。"""

import re
from datetime import datetime, timedelta

import pytest

from econ_cal.models import EconEvent, tier_for

from .conftest import ET, JST, make_event


@pytest.mark.parametrize(
    "score,tier",
    [(100, "S"), (90, "S"), (89, "A"), (75, "A"), (55, "B"), (54, "C")],
)
def test_tier_boundaries(score, tier):
    assert tier_for(score) == tier


def test_naive_datetimes_are_rejected():
    with pytest.raises(ValueError, match="timezone-aware"):
        EconEvent("x", "x", datetime(2026, 1, 1), datetime(2026, 1, 1), 50)


def test_end_before_start_is_rejected():
    start = datetime(2026, 1, 2, tzinfo=ET)
    with pytest.raises(ValueError, match="end precedes start"):
        EconEvent("x", "x", start, start - timedelta(hours=1), 50)


def test_impact_is_clamped():
    assert make_event(impact=500).impact == 100
    assert make_event(impact=-5).impact == 0


def test_uid_is_keyed_on_the_display_date():
    """22:00 ET は JST では翌日。表示日基準で ID が決まること。"""
    late = make_event(hour=22)
    assert late.uid(ET).endswith("2026-09-10")
    assert late.uid(JST).endswith("2026-09-11")


def test_uid_is_stable_across_a_small_time_shift():
    a = make_event(hour=8, minute=30)
    b = make_event(hour=10, minute=0)
    assert a.uid(JST) == b.uid(JST)


def test_gcal_id_matches_googles_charset():
    event_id = make_event().gcal_id(JST)
    assert re.fullmatch(r"[a-v0-9]{5,1024}", event_id), event_id


def test_gcal_id_differs_per_indicator_and_day():
    ids = {
        make_event("us_cpi").gcal_id(JST),
        make_event("us_ppi").gcal_id(JST),
        make_event("us_cpi", day=(2026, 9, 11)).gcal_id(JST),
    }
    assert len(ids) == 3


def test_content_hash_tracks_rendered_fields_only():
    base = make_event()
    assert base.content_hash() == make_event().content_hash()
    assert base.content_hash() != make_event(forecast="0.3%").content_hash()


def test_merge_prefers_the_higher_priority_source_for_timing():
    guess = make_event(source="rules", hour=9, estimated=True)
    official = make_event(source="fred", hour=8, minute=30, estimated=False)
    merged = guess.merged_with(official)
    assert merged.source == "fred"
    assert merged.start.hour == 8


def test_merge_backfills_figures_from_the_lower_priority_source():
    official = make_event(source="fred")
    scraped = make_event(source="investing", forecast="0.3%", previous="0.2%", actual="0.4%")
    merged = official.merged_with(scraped)
    assert merged.source == "fred"
    assert (merged.forecast, merged.previous, merged.actual) == ("0.3%", "0.2%", "0.4%")


def test_merge_is_order_independent():
    a = make_event(source="rules", estimated=True, note="なぜ効くか")
    b = make_event(source="investing", forecast="1.0%")
    assert a.merged_with(b).content_hash() == b.merged_with(a).content_hash()


def test_a_confirmed_time_replaces_an_estimate_even_from_a_lower_source():
    """FOMC(確定) は rules(推定) より優先度が高いので日時がそのまま残る。"""
    estimated_high = make_event(source="investing", estimated=True, hour=12)
    confirmed_low = make_event(source="rules", estimated=False, hour=8, minute=30)
    merged = estimated_high.merged_with(confirmed_low)
    assert merged.estimated is False
    assert merged.start.hour == 8
