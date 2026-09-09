"""Google Calendar access: credentials, calendar resolution, event CRUD.

The Google client libraries are imported lazily so the rest of the package --
providers, filtering, the terminal preview -- works with nothing installed.
"""

from __future__ import annotations

import contextlib
import json
import os
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .config import Config
from .util import log

SCOPES = ["https://www.googleapis.com/auth/calendar"]
MANAGED_KEY = "ecal"
MANAGED_VALUE = "1"

#: CI では対話ログインができないので、環境変数から資格情報を組み立てる。
ENV_TOKEN_JSON = "GOOGLE_TOKEN_JSON"
ENV_CLIENT_ID = "GOOGLE_CLIENT_ID"
ENV_CLIENT_SECRET = "GOOGLE_CLIENT_SECRET"
ENV_REFRESH_TOKEN = "GOOGLE_REFRESH_TOKEN"
ENV_SERVICE_ACCOUNT = "GOOGLE_SERVICE_ACCOUNT_JSON"

TOKEN_URI = "https://oauth2.googleapis.com/token"


class AuthError(RuntimeError):
    """No usable Google credentials could be assembled."""


def _require_google():
    try:
        from google.oauth2.credentials import Credentials  # noqa: F401
        from googleapiclient.discovery import build  # noqa: F401
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise AuthError(
            "Google のライブラリが未インストールです。\n"
            "  pip install -r requirements.txt\n"
            "を実行してください。"
        ) from exc


# ---------------------------------------------------------------------------
# credentials
# ---------------------------------------------------------------------------

def get_credentials(config: Config):
    """Resolve credentials from whichever source is configured.

    Order is deliberate: explicit environment variables win so a scheduled run
    never picks up a stale local token file by accident.
    """
    _require_google()
    from google.oauth2.credentials import Credentials
    from google.oauth2.service_account import Credentials as ServiceCredentials

    if raw := os.environ.get(ENV_SERVICE_ACCOUNT):
        info = json.loads(raw)
        log.debug("auth: サービスアカウントを使用")
        return ServiceCredentials.from_service_account_info(info, scopes=SCOPES)

    if raw := os.environ.get(ENV_TOKEN_JSON):
        log.debug("auth: %s を使用", ENV_TOKEN_JSON)
        return Credentials.from_authorized_user_info(json.loads(raw), SCOPES)

    if os.environ.get(ENV_REFRESH_TOKEN):
        missing = [k for k in (ENV_CLIENT_ID, ENV_CLIENT_SECRET) if not os.environ.get(k)]
        if missing:
            raise AuthError(f"{ENV_REFRESH_TOKEN} を使うには {', '.join(missing)} も必要です")
        log.debug("auth: リフレッシュトークンを使用")
        return Credentials(
            token=None,
            refresh_token=os.environ[ENV_REFRESH_TOKEN],
            client_id=os.environ[ENV_CLIENT_ID],
            client_secret=os.environ[ENV_CLIENT_SECRET],
            token_uri=TOKEN_URI,
            scopes=SCOPES,
        )

    token_file = Path(config.get("auth.token_file", "token.json"))
    if token_file.exists():
        log.debug("auth: %s を使用", token_file)
        return Credentials.from_authorized_user_file(str(token_file), SCOPES)

    raise AuthError(
        "Google の認証情報が見つかりません。\n"
        "  ローカル : python -m econ_cal auth を実行してブラウザで認可\n"
        "  CI       : GOOGLE_TOKEN_JSON（または CLIENT_ID/SECRET/REFRESH_TOKEN）を設定\n"
        "詳しくは README の「認証」を参照してください。"
    )


def run_oauth_flow(config: Config, port: int = 0, open_browser: bool = True) -> Path:
    """Interactive installed-app flow; writes the token file and returns it."""
    _require_google()
    from google_auth_oauthlib.flow import InstalledAppFlow

    secret_file = Path(config.get("auth.client_secret_file", "credentials.json"))
    if not secret_file.exists():
        raise AuthError(
            f"{secret_file} がありません。Google Cloud Console で OAuth クライアント"
            "（デスクトップアプリ）を作成し、JSON をこのパスに保存してください。"
        )
    flow = InstalledAppFlow.from_client_secrets_file(str(secret_file), SCOPES)
    creds = flow.run_local_server(port=port, open_browser=open_browser, prompt="consent")

    token_file = Path(config.get("auth.token_file", "token.json"))
    token_file.write_text(creds.to_json(), encoding="utf-8")
    with contextlib.suppress(OSError):  # 非 POSIX ファイルシステムでは失敗しうる
        token_file.chmod(0o600)
    return token_file


# ---------------------------------------------------------------------------
# client
# ---------------------------------------------------------------------------

class CalendarClient:
    """Thin wrapper over the Calendar v3 API with the retries it needs."""

    def __init__(self, config: Config, service=None):
        self.config = config
        self._service = service

    @property
    def service(self):
        if self._service is None:
            _require_google()
            from googleapiclient.discovery import build

            self._service = build(
                "calendar", "v3", credentials=get_credentials(self.config),
                cache_discovery=False,
            )
        return self._service

    # -- calendar -----------------------------------------------------------

    def ensure_calendar(self, create: bool = True) -> str:
        """Return the target calendar id, creating the calendar if needed."""
        configured = self.config.get("calendar.id")
        if configured:
            return configured

        name = self.config.get("calendar.name")
        page_token = None
        while True:
            response = self._call(
                self.service.calendarList().list(pageToken=page_token, maxResults=250)
            )
            for item in response.get("items", []):
                if item.get("summary") == name:
                    return item["id"]
            page_token = response.get("nextPageToken")
            if not page_token:
                break

        if not create:
            raise RuntimeError(f"カレンダー「{name}」が見つかりません")

        log.info("カレンダー「%s」を作成します", name)
        created = self._call(
            self.service.calendars().insert(
                body={
                    "summary": name,
                    "description": self.config.get("calendar.description", ""),
                    "timeZone": self.config.get("timezone"),
                }
            )
        )
        return created["id"]

    def list_calendars(self) -> list[dict]:
        """Every calendar the credentials can see, for the ``calendars`` command."""
        out: list[dict] = []
        page_token = None
        while True:
            response = self._call(
                self.service.calendarList().list(pageToken=page_token, maxResults=250)
            )
            out += response.get("items", [])
            page_token = response.get("nextPageToken")
            if not page_token:
                return out

    # -- events -------------------------------------------------------------

    def list_managed(self, calendar_id: str, time_min: str, time_max: str) -> Iterator[dict]:
        """Only events this tool created, identified by a private property."""
        page_token = None
        while True:
            response = self._call(
                self.service.events().list(
                    calendarId=calendar_id,
                    timeMin=time_min,
                    timeMax=time_max,
                    singleEvents=True,
                    showDeleted=False,
                    maxResults=2500,
                    privateExtendedProperty=f"{MANAGED_KEY}={MANAGED_VALUE}",
                    pageToken=page_token,
                )
            )
            yield from response.get("items", [])
            page_token = response.get("nextPageToken")
            if not page_token:
                return

    def insert(self, calendar_id: str, body: dict[str, Any]) -> dict:
        return self._call(self.service.events().insert(calendarId=calendar_id, body=body))

    def update(self, calendar_id: str, event_id: str, body: dict[str, Any]) -> dict:
        return self._call(
            self.service.events().update(calendarId=calendar_id, eventId=event_id, body=body)
        )

    def delete(self, calendar_id: str, event_id: str) -> None:
        from googleapiclient.errors import HttpError

        try:
            self._call(self.service.events().delete(calendarId=calendar_id, eventId=event_id))
        except HttpError as exc:
            if exc.resp.status not in (404, 410):  # already gone is a success
                raise

    # -- plumbing -----------------------------------------------------------

    @staticmethod
    def _call(request, retries: int = 4):
        """Execute a request, backing off on the errors Google asks us to retry."""
        from googleapiclient.errors import HttpError

        delay = 1.0
        for attempt in range(1, retries + 1):
            try:
                return request.execute()
            except HttpError as exc:
                status = getattr(exc.resp, "status", 0)
                retriable = status in (403, 429, 500, 502, 503, 504)
                if not retriable or attempt == retries:
                    raise
                log.debug("Google API %s / %s回目を再試行", status, attempt)
                time.sleep(delay)
                delay *= 2
