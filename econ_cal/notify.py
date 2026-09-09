"""Optional webhook notification (Slack / Discord compatible)."""

from __future__ import annotations

import json
import os
import urllib.request

from .config import Config
from .util import USER_AGENT, FetchError, log

MAX_LENGTH = 3500  # Slack/Discord のどちらにも収まる長さ


def send(config: Config, text: str) -> bool:
    """Post ``text`` to the configured webhook.  Returns False when unset.

    Slack reads ``text`` and Discord reads ``content``; sending both keys makes
    one payload work with either without the user telling us which it is.
    """
    env_name = config.get("digest.webhook_url_env", "ECON_CAL_WEBHOOK_URL")
    url = os.environ.get(env_name or "", "")
    if not url:
        return False

    body = text if len(text) <= MAX_LENGTH else text[: MAX_LENGTH - 3] + "..."
    payload = json.dumps({"text": body, "content": body}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            log.info("Webhook 送信: HTTP %s", response.status)
            return True
    except OSError as exc:
        raise FetchError(f"Webhook への送信に失敗しました: {exc}") from exc
