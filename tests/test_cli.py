"""CLI の入口。Google に触れないコマンドだけを実行する。"""

import pytest

from econ_cal.cli import main


def run(argv, capsys):
    code = main(argv)
    return code, capsys.readouterr().out


def test_preview_lists_events(capsys, monkeypatch):
    monkeypatch.setenv("ECON_CAL_DAYS_AHEAD", "0")  # 環境変数側は CLI 引数で上書きされる
    code, out = run(["preview", "--days-ahead", "30", "--days-back", "0"], capsys)
    assert code == 0
    assert "内訳:" in out and "🔴" in out


def test_preview_all_lowers_the_threshold(capsys):
    _, strict = run(["preview", "--days-ahead", "30", "--min-impact", "90"], capsys)
    _, loose = run(["preview", "--days-ahead", "30", "--all"], capsys)
    assert loose.count("\n") > strict.count("\n")


def test_min_impact_flag_filters(capsys):
    _, out = run(["preview", "--days-ahead", "40", "--min-impact", "95"], capsys)
    assert "🟡" not in out


def test_indicators_command_prints_the_catalog(capsys):
    code, out = run(["indicators"], capsys)
    assert code == 0 and "us_cpi" in out and "合計" in out


def test_digest_command_runs_offline(capsys):
    code, out = run(["digest", "--days", "10"], capsys)
    assert code == 0 and "📊 経済指標" in out


def test_doctor_reports_without_crashing(capsys):
    code, out = run(["doctor"], capsys)
    assert code in (0, 1)
    assert "指標カタログ" in out and "有効な取得元" in out


def test_bad_timezone_is_reported_not_raised(capsys):
    code = main(["preview", "--tz", "Mars/Olympus"])
    assert code == 2
    assert "timezone" in capsys.readouterr().err


def test_unknown_command_exits():
    with pytest.raises(SystemExit):
        main(["teleport"])


def test_cli_flags_beat_the_config_file(tmp_path, capsys):
    path = tmp_path / "config.yaml"
    path.write_text("filter:\n  min_impact: 10\n", encoding="utf-8")
    argv = ["-c", str(path), "preview", "--min-impact", "95", "--days-ahead", "40"]
    code, out = run(argv, capsys)
    assert code == 0 and "🟡" not in out
