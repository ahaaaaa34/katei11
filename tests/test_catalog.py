"""指標カタログの整合性。壊れた YAML が本番に出ないようにする。"""

import pytest

from econ_cal.catalog import load_catalog, load_meetings
from econ_cal.schedule import WEEKDAYS


@pytest.fixture(scope="module")
def catalog():
    return load_catalog()


def test_catalog_loads_and_ids_are_unique(catalog):
    ids = [i.id for i in catalog]
    assert len(ids) == len(set(ids))
    assert len(catalog) > 30


def test_every_indicator_has_a_reason_and_a_sane_score(catalog):
    for ind in catalog:
        assert 0 <= ind.impact <= 100, ind.id
        assert ind.why.strip(), f"{ind.id} に why がありません"
        assert ind.category, ind.id


def test_scheduled_indicators_have_a_valid_rule(catalog):
    valid = {"nth_business_day", "nth_weekday", "day_of_month", "weekly", "none"}
    for ind in catalog:
        kind = ind.schedule.get("type", "none")
        assert kind in valid, f"{ind.id}: {kind}"
        if kind == "nth_weekday":
            assert ind.schedule["weekday"] in WEEKDAYS, ind.id
            assert ind.schedule["n"] != 0, ind.id
        if kind in {"nth_business_day", "nth_weekday", "day_of_month"}:
            assert ind.time or ind.all_day, f"{ind.id} に time がありません"


def test_time_fields_parse(catalog):
    for ind in catalog:
        if not ind.time:
            continue
        hour, minute = (int(x) for x in ind.time.split(":"))
        assert 0 <= hour < 24 and 0 <= minute < 60, ind.id


def test_the_headline_releases_are_present_and_top_ranked(catalog):
    for indicator_id in ("us_cpi", "us_nfp", "us_fomc_rate", "us_pce"):
        assert catalog.require(indicator_id).impact >= 90


def test_name_matching_prefers_the_more_specific_pattern(catalog):
    assert catalog.match_name("Core CPI (MoM) (Aug)").id == "us_cpi"
    assert catalog.match_name("ISM Non-Manufacturing PMI").id == "us_ism_services"
    assert catalog.match_name("Fed Chair Powell Speaks").id == "us_fed_speech"
    assert catalog.match_name("Belgian Bread Price Index") is None


def test_fred_release_patterns_map_to_indicators(catalog):
    assert catalog.match_fred_release("Employment Situation").id == "us_nfp"
    assert catalog.match_fred_release("Consumer Price Index").id == "us_cpi"


def test_unknown_key_in_the_yaml_is_rejected(tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text(
        "version: 1\nindicators:\n  - id: x\n    name: x\n    country: US\n"
        "    category: fed\n    impact: 10\n    typo_field: 1\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="unknown catalog keys"):
        load_catalog(str(bad))


def test_meetings_file_is_chronological_and_reasonable():
    meetings = load_meetings()["fomc"]["meetings"]
    dates = [m["date"] for m in meetings]
    assert dates == sorted(dates)
    assert len(dates) == 8, "FOMC は年8回"
    assert sum(1 for m in meetings if m.get("sep")) == 4, "SEP は年4回"
