"""放置運用の見張り。手当てが必要になった時に、必要になった分だけ鳴ること。"""

from datetime import date, timedelta

import pytest

from econ_cal.health import (
    ACTION,
    INFO,
    Finding,
    as_text,
    maintenance_report,
    needs_action,
)


def findings_on(config, today):
    return {f.key: f for f in maintenance_report(config, today)}


def test_nothing_to_do_while_the_meeting_data_is_far_ahead(config, tmp_path, monkeypatch):
    """会合日程が同期範囲の十分先まであるうちは静かにしている。"""
    config.data["window"] = {"days_back": 5, "days_ahead": 10}
    monkeypatch.setenv("FRED_API_KEY", "dummy")
    monkeypatch.delenv("ECON_CAL_OFFLINE", raising=False)
    assert maintenance_report(config, date(2026, 6, 1)) == []


def test_it_warns_before_the_meeting_data_runs_out(config):
    """まだ足りているが猶予が減ってきた段階では情報レベル。"""
    config.data["window"] = {"days_back": 5, "days_ahead": 60}
    finding = findings_on(config, date(2026, 9, 9))["meetings:fomc"]
    assert finding.severity == INFO
    assert "2026-12-09" in finding.message


def test_it_escalates_once_the_window_reaches_the_gap(config):
    """同期範囲が空白域に入ったら、人を呼ぶレベルに上げる。"""
    config.data["window"] = {"days_back": 5, "days_ahead": 60}
    finding = findings_on(config, date(2026, 10, 15))["meetings:fomc"]
    assert finding.severity == ACTION
    assert needs_action(list(findings_on(config, date(2026, 10, 15)).values()))


def test_an_expired_list_is_phrased_as_expired(config):
    finding = findings_on(config, date(2027, 1, 5))["meetings:fomc"]
    assert "期限切れ" in finding.message
    assert finding.severity == ACTION


def test_the_fix_tells_you_where_to_look(config):
    finding = findings_on(config, date(2026, 10, 15))["meetings:fomc"]
    assert "federalreserve.gov" in finding.fix
    assert "meetings.yaml" in finding.fix


def test_empty_boj_and_ecb_do_not_nag(config):
    """既定で空なので、未登録であること自体は指摘しない。"""
    keys = findings_on(config, date(2026, 10, 15))
    assert "meetings:boj" not in keys and "meetings:ecb" not in keys


def test_missing_fred_key_is_info_only(config, monkeypatch):
    monkeypatch.delenv("ECON_CAL_OFFLINE", raising=False)
    monkeypatch.delenv("FRED_API_KEY", raising=False)
    finding = findings_on(config, date(2026, 6, 1))["provider:fred"]
    assert finding.severity == INFO
    assert not needs_action([finding])


def test_offline_mode_does_not_complain_about_fred(config):
    """--offline は意図的な選択なので、無効なこと自体は指摘しない。"""
    assert "provider:fred" not in findings_on(config, date(2026, 6, 1))


def test_action_items_are_marked_in_the_text():
    text = as_text([
        Finding("a", ACTION, "壊れています", "直してください"),
        Finding("b", INFO, "改善できます", "設定してください"),
    ])
    assert text.startswith("❗ 壊れています")
    assert "・ 改善できます" in text
    assert "→ 直してください" in text


def test_empty_report_says_so():
    assert "必要な項目はありません" in as_text([])


@pytest.mark.parametrize("days_ahead", [0, 30, 200])
def test_the_check_scales_with_the_sync_window(config, days_ahead):
    """同期範囲を伸ばすほど、より早く会合日程の追記を求める。"""
    config.data["window"] = {"days_back": 0, "days_ahead": days_ahead}
    today = date(2026, 9, 9)
    report = maintenance_report(config, today)
    gap = date(2026, 12, 9) - (today + timedelta(days=days_ahead))
    expected_action = gap.days < 0
    assert needs_action(report) is expected_action
