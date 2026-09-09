"""表示文字列と週次ダイジェスト。"""

from datetime import date

import pytest

from econ_cal import render
from econ_cal.digest import DIGEST_ID, digest_text, week_starts, weekly_events

from .conftest import make_event


@pytest.mark.parametrize(
    "impact,expected",
    [(98, "★★★★★"), (80, "★★★★☆"), (60, "★★★☆☆"), (10, "★☆☆☆☆")],
)
def test_stars(impact, expected):
    assert render.stars(impact) == expected


def test_title_carries_the_rank_and_country(config):
    title = render.title(make_event(impact=98, title="米 CPI"), config)
    assert title.startswith("🔴 🇺🇸") and "米 CPI" in title


def test_title_shows_the_result_once_released(config):
    assert "→ 0.2%" in render.title(make_event(actual="0.2%"), config)


def test_title_warns_while_the_date_is_a_guess(config):
    assert "予定日未確定" in render.title(make_event(estimated=True), config)


def test_a_released_result_replaces_the_unconfirmed_marker(config):
    title = render.title(make_event(estimated=True, actual="0.2%"), config)
    assert "予定日未確定" not in title and "0.2%" in title


def test_description_includes_the_figures_and_both_clocks(config):
    event = make_event(forecast="0.3%", previous="0.2%", actual="0.4%", note="効き方の説明")
    text = render.description(event, config)
    assert "予想  0.3%" in text and "前回  0.2%" in text and "結果  0.4%" in text
    assert "ET)" in text                      # 現地時間も併記する
    assert "効き方の説明" in text
    assert render.MARKER in text              # 自動生成の目印


def test_description_omits_the_figure_block_when_empty(config):
    assert "予想" not in render.description(make_event(), config)


def test_description_warns_about_estimated_dates(config):
    assert "推定" in render.description(make_event(estimated=True), config)


def test_all_day_events_say_all_day(config):
    text = render.description(make_event(all_day=True, hour=0, minute=0), config)
    assert "終日" in text


def test_display_toggles_are_respected(config):
    config.data["display"] = {
        "impact_emoji": False, "show_country_flag": False, "show_score": True
    }
    title = render.title(make_event(impact=98, title="米 CPI"), config)
    assert title == "米 CPI [98]"


def test_week_starts_are_mondays():
    starts = week_starts(date(2026, 9, 9), date(2026, 9, 30))
    assert all(d.weekday() == 0 for d in starts)
    assert starts[0] == date(2026, 9, 7)


def test_weekly_digest_lists_only_the_important_ones(config):
    events = [
        make_event("a", day=(2026, 9, 14), impact=98, title="CPI"),
        make_event("b", day=(2026, 9, 15), impact=60, title="住宅着工"),
    ]
    digests = weekly_events(events, config, date(2026, 9, 14), date(2026, 9, 20))
    assert len(digests) == 1
    assert digests[0].indicator_id == DIGEST_ID and digests[0].all_day
    assert "CPI" in digests[0].note and "住宅着工" not in digests[0].note


def test_weekly_digest_counts_the_top_rank(config):
    events = [make_event(f"e{i}", day=(2026, 9, 14), impact=98) for i in range(3)]
    digest = weekly_events(events, config, date(2026, 9, 14), date(2026, 9, 20))[0]
    assert "最重要 3件" in digest.title


def test_weekly_digest_can_be_switched_off(config):
    config.data["digest"]["weekly_event"] = False
    week = weekly_events([make_event(impact=98)], config, date(2026, 9, 14), date(2026, 9, 20))
    assert week == []


def test_weekly_digest_skips_a_partial_first_week(config):
    """同期範囲が水曜から始まる場合、その週の要約は作らない。"""
    events = [make_event(day=(2026, 9, 17), impact=98)]
    assert weekly_events(events, config, date(2026, 9, 16), date(2026, 9, 20)) == []


def test_digest_text_groups_by_day(config):
    text = digest_text(
        [make_event("a", day=(2026, 9, 14)), make_event("b", day=(2026, 9, 15))],
        config, date(2026, 9, 14), date(2026, 9, 20),
    )
    assert "*09/14(月)*" in text and "*09/15(火)*" in text


def test_digest_text_handles_an_empty_week(config):
    assert "（該当なし）" in digest_text([], config, date(2026, 9, 14), date(2026, 9, 20))
