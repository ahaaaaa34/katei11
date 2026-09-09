"""US カレンダーと繰り返しルールの検証。"""

from datetime import date

import pytest

from econ_cal.schedule import (
    at_local_time,
    business_days_in_month,
    easter,
    federal_holidays,
    market_early_closes,
    market_holidays,
    rule_dates,
)


@pytest.mark.parametrize(
    "year,expected",
    [(2024, date(2024, 3, 31)), (2025, date(2025, 4, 20)), (2026, date(2026, 4, 5))],
)
def test_easter(year, expected):
    assert easter(year) == expected


def test_good_friday_closes_the_market_but_not_the_agencies():
    good_friday = easter(2026) - __import__("datetime").timedelta(days=2)
    assert good_friday in market_holidays(2026)
    assert good_friday not in federal_holidays(2026)


def test_columbus_day_closes_the_agencies_but_not_the_market():
    columbus = date(2026, 10, 12)
    assert columbus in federal_holidays(2026)
    assert columbus not in market_holidays(2026)


def test_saturday_holiday_is_observed_on_friday():
    # 2026-07-04 は土曜 → 7/3 金曜が休場
    assert date(2026, 7, 3) in market_holidays(2026)
    # その日は休場なので短縮取引にはしない
    assert date(2026, 7, 3) not in market_early_closes(2026)


def test_saturday_new_year_does_not_close_the_prior_friday():
    # 2027-01-01 は金曜なので休場、2022-01-01 は土曜で 12/31 は通常取引
    assert date(2027, 1, 1) in market_holidays(2027)
    assert date(2021, 12, 31) not in market_holidays(2021)


def test_black_friday_is_a_half_day():
    assert market_early_closes(2026)[date(2026, 11, 27)] == "感謝祭翌日"


def test_first_business_day_skips_holidays():
    # 2026-11-01 は日曜、11/2 月曜が第1営業日
    assert business_days_in_month(2026, 11)[0] == date(2026, 11, 2)


def test_nth_business_day_rule():
    got = rule_dates({"type": "nth_business_day", "n": 3}, date(2026, 9, 1), date(2026, 9, 30))
    assert got == [date(2026, 9, 3)]


def test_last_business_day_rule():
    got = rule_dates({"type": "nth_business_day", "n": -1}, date(2026, 11, 1), date(2026, 11, 30))
    assert got == [date(2026, 11, 30)]


def test_nth_weekday_rule():
    got = rule_dates(
        {"type": "nth_weekday", "weekday": "fri", "n": 1}, date(2026, 9, 1), date(2026, 10, 31)
    )
    assert got == [date(2026, 9, 4), date(2026, 10, 2)]


def test_last_weekday_rule():
    got = rule_dates(
        {"type": "nth_weekday", "weekday": "tue", "n": -1}, date(2026, 9, 1), date(2026, 9, 30)
    )
    assert got == [date(2026, 9, 29)]


def test_weekly_rule_moves_off_a_holiday():
    # 感謝祭 (2026-11-26 木) の週は水曜に前倒しされる
    got = rule_dates({"type": "weekly", "weekday": "thu"}, date(2026, 11, 20), date(2026, 11, 30))
    assert date(2026, 11, 25) in got
    assert date(2026, 11, 26) not in got


def test_day_of_month_rule_pushes_to_a_business_day():
    # 2026-09-12 は土曜 → 9/14 月曜
    got = rule_dates({"type": "day_of_month", "day": 12}, date(2026, 9, 1), date(2026, 9, 30))
    assert got == [date(2026, 9, 14)]


def test_months_filter():
    got = rule_dates(
        {"type": "nth_business_day", "n": 1, "months": [1, 4]},
        date(2026, 1, 1),
        date(2026, 12, 31),
    )
    assert [d.month for d in got] == [1, 4]


def test_unknown_rule_type_is_rejected():
    with pytest.raises(ValueError, match="unknown schedule rule"):
        rule_dates({"type": "phase_of_moon"}, date(2026, 1, 1), date(2026, 2, 1))


def test_at_local_time_handles_dst():
    summer = at_local_time(date(2026, 7, 10), "08:30")
    winter = at_local_time(date(2026, 12, 10), "08:30")
    assert summer.utcoffset().total_seconds() == -4 * 3600
    assert winter.utcoffset().total_seconds() == -5 * 3600
