"""差分計算。カレンダーを壊さないための一番大事な部分。"""

from datetime import date

from econ_cal.gcal import MANAGED_KEY, MANAGED_VALUE
from econ_cal.sync import build_plan, to_google_body

from .conftest import make_event

START, END = date(2026, 9, 1), date(2026, 9, 30)


class FakeClient:
    """build_plan が呼ぶ API だけを持つスタブ。"""

    def __init__(self, existing=()):
        self.existing = list(existing)
        self.deleted: list[str] = []

    def ensure_calendar(self, create=True):
        return "cal-123"

    def list_managed(self, calendar_id, time_min, time_max):
        return iter(self.existing)

    def delete(self, calendar_id, event_id):
        self.deleted.append(event_id)


def stored(event, config, *, stale=False):
    """カレンダー側に既にあるイベントの表現を作る。"""
    body = to_google_body(event, config)
    return {
        "id": body["id"],
        "summary": body["summary"],
        "extendedProperties": {
            "private": {
                MANAGED_KEY: MANAGED_VALUE,
                "hash": "outdated" if stale else event.content_hash(),
            }
        },
    }


def test_body_marks_the_event_as_managed(config):
    body = to_google_body(make_event(), config)
    assert body["extendedProperties"]["private"][MANAGED_KEY] == MANAGED_VALUE
    assert body["transparency"] == "transparent"  # 予定を「予定あり」にしない


def test_body_uses_date_only_for_all_day_events(config):
    event = make_event(impact=60, all_day=True, hour=0, minute=0)
    body = to_google_body(event, config)
    assert set(body["start"]) == {"date"}
    assert body["end"]["date"] > body["start"]["date"]


def test_reminders_follow_the_tier(config):
    high = to_google_body(make_event(impact=98), config)["reminders"]["overrides"]
    low = to_google_body(make_event(impact=60), config)["reminders"]["overrides"]
    assert [r["minutes"] for r in high] == [1440, 30]
    assert low == []


def test_reminders_are_capped_at_googles_limit(config):
    config.data["reminders"]["S"] = [1, 2, 3, 4, 5, 6, 7]
    assert len(to_google_body(make_event(impact=95), config)["reminders"]["overrides"]) == 5


def test_new_events_are_created(config):
    plan = build_plan(FakeClient(), config, [make_event()], START, END)
    assert len(plan.created) == 1
    assert plan.changes == 1


def test_identical_events_are_left_alone(config):
    event = make_event()
    plan = build_plan(FakeClient([stored(event, config)]), config, [event], START, END)
    assert (len(plan.created), len(plan.updated), len(plan.deleted)) == (0, 0, 0)
    assert len(plan.unchanged) == 1
    assert plan.changes == 0


def test_a_changed_figure_triggers_an_update_not_a_duplicate(config):
    event = make_event()
    with_result = make_event(actual="0.4%")
    client = FakeClient([stored(event, config, stale=True)])
    plan = build_plan(client, config, [with_result], START, END)
    assert len(plan.updated) == 1
    assert not plan.created


def test_a_dropped_event_is_deleted(config):
    orphan = stored(make_event("us_old"), config)
    plan = build_plan(FakeClient([orphan]), config, [], START, END)
    assert [item["id"] for item in plan.deleted] == [orphan["id"]]


def test_a_rescheduled_release_moves_rather_than_duplicating(config):
    """発表日が動いたら、旧イベントは削除され新イベントが作られる。"""
    old = make_event(day=(2026, 9, 14), estimated=True)
    new = make_event(day=(2026, 9, 11), estimated=False)
    plan = build_plan(FakeClient([stored(old, config)]), config, [new], START, END)
    assert len(plan.created) == 1 and len(plan.deleted) == 1


def test_the_plan_is_stable_when_run_twice(config):
    """同期が冪等であること = 毎日回しても差分が出ない。"""
    events = [make_event("us_cpi"), make_event("us_nfp", day=(2026, 9, 4))]
    existing = [stored(e, config) for e in events]
    plan = build_plan(FakeClient(existing), config, events, START, END)
    assert plan.changes == 0


def test_summary_is_human_readable(config):
    plan = build_plan(FakeClient(), config, [make_event()], START, END)
    assert "新規 1" in plan.summary()
