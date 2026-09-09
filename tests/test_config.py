"""設定の読み込み・上書き・検証。"""

import pytest

from econ_cal.config import Config


def test_defaults_are_usable_without_a_file():
    config = Config.load(None)
    assert config.get("timezone") == "Asia/Tokyo"
    assert config.provider_enabled("rules") is True


def test_yaml_overlays_only_the_keys_it_sets(tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text("filter:\n  min_impact: 90\n", encoding="utf-8")
    config = Config.load(path)
    assert config.get("filter.min_impact") == 90
    assert config.get("filter.countries") == ["US", "JP", "EU", "CN"]  # 既定値が残る


def test_missing_config_file_is_an_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        Config.load(tmp_path / "nope.yaml")


def test_environment_overrides_the_file(tmp_path, monkeypatch):
    path = tmp_path / "config.yaml"
    path.write_text("filter:\n  min_impact: 90\n", encoding="utf-8")
    monkeypatch.setenv("ECON_CAL_MIN_IMPACT", "40")
    monkeypatch.setenv("ECON_CAL_TIMEZONE", "America/New_York")
    config = Config.load(path)
    assert config.get("filter.min_impact") == 40
    assert config.get("timezone") == "America/New_York"


def test_auto_provider_follows_its_api_key(monkeypatch):
    monkeypatch.delenv("ECON_CAL_OFFLINE", raising=False)
    config = Config.load(None)
    monkeypatch.delenv("FRED_API_KEY", raising=False)
    assert config.provider_enabled("fred") is False
    monkeypatch.setenv("FRED_API_KEY", "abc")
    assert config.provider_enabled("fred") is True


@pytest.mark.parametrize(
    "patch,message",
    [
        ({"timezone": "Mars/Olympus"}, "timezone"),
        ({"filter": {"min_impact": 900}}, "min_impact"),
        ({"window": {"days_ahead": -1, "days_back": 1}}, "days_ahead"),
        ({"window": {"days_ahead": 4000, "days_back": 1}}, "400"),
        ({"reminders": {"S": [99999]}}, "reminders"),
    ],
)
def test_invalid_settings_are_rejected_with_a_useful_message(tmp_path, patch, message):
    import yaml

    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(patch), encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        Config.load(path)


def test_offline_mode_disables_the_networked_providers(monkeypatch):
    config = Config.load(None)
    monkeypatch.setenv("FRED_API_KEY", "abc")
    monkeypatch.setenv("ECON_CAL_OFFLINE", "1")
    assert config.provider_enabled("fred") is False
    assert config.provider_enabled("earnings") is False
    assert config.provider_enabled("rules") is True   # ローカル計算は残る


def test_dotted_lookup_returns_the_default_for_missing_keys():
    assert Config.load(None).get("nope.nothing.here", "fallback") == "fallback"
