"""Google Calendar クライアントと同期の適用。API をモックして往復を検証する。"""

from datetime import date

import pytest

from econ_cal.gcal import MANAGED_KEY, MANAGED_VALUE, AuthError, CalendarClient, get_credentials
from econ_cal.sync import apply_plan, build_plan, to_google_body

from .conftest import make_event

googleapiclient = pytest.importorskip("googleapiclient")
from googleapiclient.errors import HttpError  # noqa: E402

START, END = date(2026, 9, 1), date(2026, 9, 30)


class Resp:
    def __init__(self, status):
        self.status = status
        self.reason = "test"


class Request:
    def __init__(self, result=None, error=None):
        self._result, self._error = result, error

    def execute(self):
        if self._error:
            raise self._error
        return self._result


class FakeEvents:
    def __init__(self, service):
        self.s = service

    def list(self, **kwargs):
        self.s.calls.append(("list", kwargs))
        assert kwargs["privateExtendedProperty"] == f"{MANAGED_KEY}={MANAGED_VALUE}"
        page = self.s.pages.pop(0) if self.s.pages else {"items": []}
        return Request(page)

    def insert(self, calendarId, body):
        self.s.calls.append(("insert", body["id"]))
        if body["id"] in self.s.conflict_ids:
            return Request(error=HttpError(Resp(409), b"duplicate"))
        self.s.store[body["id"]] = body
        return Request(body)

    def update(self, calendarId, eventId, body):
        self.s.calls.append(("update", eventId))
        self.s.store[eventId] = body
        return Request(body)

    def delete(self, calendarId, eventId):
        self.s.calls.append(("delete", eventId))
        if eventId in self.s.missing_ids:
            return Request(error=HttpError(Resp(404), b"gone"))
        self.s.store.pop(eventId, None)
        return Request({})


class FakeService:
    def __init__(self, calendars=(), pages=None, conflict_ids=(), missing_ids=()):
        self._calendars = list(calendars)
        self.pages = list(pages or [])
        self.conflict_ids = set(conflict_ids)
        self.missing_ids = set(missing_ids)
        self.store: dict[str, dict] = {}
        self.calls: list[tuple] = []
        self.created_calendar: dict | None = None

    def calendarList(self):
        service = self

        class _List:
            def list(self, **kwargs):
                service.calls.append(("calendarList", kwargs))
                return Request({"items": service._calendars})

        return _List()

    def calendars(self):
        service = self

        class _Cal:
            def insert(self, body):
                service.created_calendar = body
                return Request({"id": "new-cal@group.calendar.google.com"})

        return _Cal()

    def events(self):
        return FakeEvents(self)


# --- credentials -----------------------------------------------------------

def test_missing_credentials_raise_a_guiding_error(config, monkeypatch, tmp_path):
    for name in ("GOOGLE_TOKEN_JSON", "GOOGLE_REFRESH_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON"):
        monkeypatch.delenv(name, raising=False)
    config.data["auth"]["token_file"] = str(tmp_path / "absent.json")
    with pytest.raises(AuthError, match="econ_cal auth"):
        get_credentials(config)


def test_refresh_token_without_client_id_is_reported(config, monkeypatch):
    monkeypatch.delenv("GOOGLE_TOKEN_JSON", raising=False)
    monkeypatch.delenv("GOOGLE_SERVICE_ACCOUNT_JSON", raising=False)
    monkeypatch.setenv("GOOGLE_REFRESH_TOKEN", "x")
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_CLIENT_SECRET", raising=False)
    with pytest.raises(AuthError, match="GOOGLE_CLIENT_ID"):
        get_credentials(config)


# --- calendar resolution ---------------------------------------------------

def test_existing_calendar_is_reused(config):
    service = FakeService(calendars=[{"id": "abc", "summary": config.get("calendar.name")}])
    assert CalendarClient(config, service).ensure_calendar() == "abc"
    assert service.created_calendar is None


def test_calendar_is_created_when_absent(config):
    service = FakeService(calendars=[{"id": "other", "summary": "仕事"}])
    calendar_id = CalendarClient(config, service).ensure_calendar()
    assert calendar_id == "new-cal@group.calendar.google.com"
    assert service.created_calendar["summary"] == config.get("calendar.name")
    assert service.created_calendar["timeZone"] == "Asia/Tokyo"


def test_configured_id_skips_the_lookup_entirely(config):
    config.data["calendar"]["id"] = "explicit@group.calendar.google.com"
    service = FakeService()
    assert CalendarClient(config, service).ensure_calendar() == "explicit@group.calendar.google.com"
    assert service.calls == []


def test_create_false_raises_instead_of_creating(config):
    with pytest.raises(RuntimeError, match="見つかりません"):
        CalendarClient(config, FakeService()).ensure_calendar(create=False)


def test_listing_follows_pagination(config):
    service = FakeService(
        calendars=[{"id": "abc", "summary": config.get("calendar.name")}],
        pages=[
            {"items": [{"id": "e1"}], "nextPageToken": "t"},
            {"items": [{"id": "e2"}]},
        ],
    )
    items = list(CalendarClient(config, service).list_managed("abc", "a", "b"))
    assert [i["id"] for i in items] == ["e1", "e2"]


# --- applying a plan -------------------------------------------------------

def _client(config, existing=()):
    service = FakeService(
        calendars=[{"id": "cal", "summary": config.get("calendar.name")}],
        pages=[{"items": list(existing)}],
    )
    return CalendarClient(config, service), service


def test_apply_creates_updates_and_deletes(config):
    keep = make_event("us_cpi")
    change = make_event("us_nfp", day=(2026, 9, 4))
    orphan_body = to_google_body(make_event("us_old", day=(2026, 9, 2)), config)
    existing = [
        {"id": to_google_body(keep, config)["id"],
         "extendedProperties": {"private": {"hash": keep.content_hash()}}},
        {"id": to_google_body(change, config)["id"],
         "extendedProperties": {"private": {"hash": "stale"}}},
        {"id": orphan_body["id"], "extendedProperties": {"private": {"hash": "x"}}},
    ]
    client, service = _client(config, existing)
    plan = apply_plan(client, build_plan(client, config, [keep, change], START, END))

    verbs = [c[0] for c in service.calls if c[0] in ("insert", "update", "delete")]
    assert verbs == ["update", "delete"]          # 変化なしのものは触らない
    assert len(plan.unchanged) == 1


def test_insert_conflict_falls_back_to_update(config):
    """ID が既に存在する（窓の外にあった等）場合も失敗させない。"""
    event = make_event()
    event_id = to_google_body(event, config)["id"]
    client, service = _client(config)
    service.conflict_ids = {event_id}

    apply_plan(client, build_plan(client, config, [event], START, END))
    assert ("update", event_id) in service.calls


def test_delete_of_an_already_gone_event_is_not_an_error(config):
    orphan = to_google_body(make_event("us_old"), config)
    client, service = _client(
        config, [{"id": orphan["id"], "extendedProperties": {"private": {"hash": "x"}}}]
    )
    service.missing_ids = {orphan["id"]}
    apply_plan(client, build_plan(client, config, [], START, END))  # 例外が出なければ合格


def test_a_real_error_on_insert_is_raised(config):
    """409 以外の失敗は握りつぶさず、はっきり落とす。"""
    client, service = _client(config)
    plan = build_plan(client, config, [], START, END)

    class Failing(FakeEvents):
        def insert(self, calendarId, body):
            return Request(error=HttpError(Resp(400), b"bad request"))

    service.events = lambda: Failing(service)
    event = make_event()
    plan.created.append((event, to_google_body(event, config)))
    with pytest.raises(HttpError):
        apply_plan(client, plan)


def test_a_second_run_is_a_no_op(config):
    """毎日回しても差分が出ないこと（冪等性）。"""
    events = [make_event("us_cpi"), make_event("us_nfp", day=(2026, 9, 4))]
    client, service = _client(config)
    apply_plan(client, build_plan(client, config, events, START, END))

    stored = [
        {"id": body["id"], "extendedProperties": body["extendedProperties"]}
        for body in service.store.values()
    ]
    client2, service2 = _client(config, stored)
    plan = apply_plan(client2, build_plan(client2, config, events, START, END))
    assert plan.changes == 0
    assert not [c for c in service2.calls if c[0] in ("insert", "update", "delete")]
