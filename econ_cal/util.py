"""Small shared helpers: HTTP, logging, formatting."""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

log = logging.getLogger("econ_cal")

USER_AGENT = "econ-calendar/1.0 (+https://github.com/; personal calendar sync)"


class FetchError(RuntimeError):
    """A provider could not reach or parse its upstream source."""


def setup_logging(verbose: bool = False, quiet: bool = False) -> None:
    level = logging.DEBUG if verbose else logging.WARNING if quiet else logging.INFO
    logging.basicConfig(level=level, format="%(levelname)-7s %(message)s")


def http_get(
    url: str,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 20,
    retries: int = 3,
) -> bytes:
    """GET with exponential backoff.

    Retries only on transport errors and 5xx/429 -- a 4xx means the request
    itself is wrong and retrying just wastes the upstream's goodwill.
    """
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})

    delay = 1.0
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in (429, 500, 502, 503, 504):
                raise FetchError(f"{url} -> HTTP {exc.code} {exc.reason}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
        if attempt < retries:
            log.debug("retry %s/%s for %s (%s)", attempt, retries, url, last)
            time.sleep(delay)
            delay *= 2
    raise FetchError(f"{url} に接続できませんでした: {last}")


def http_post(
    url: str,
    data: dict[str, Any],
    headers: dict[str, str] | None = None,
    timeout: int = 20,
    retries: int = 3,
) -> bytes:
    body = urllib.parse.urlencode(data, doseq=True).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            **(headers or {}),
        },
    )
    delay = 1.0
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in (429, 500, 502, 503, 504):
                raise FetchError(f"{url} -> HTTP {exc.code} {exc.reason}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
        if attempt < retries:
            time.sleep(delay)
            delay *= 2
    raise FetchError(f"{url} に接続できませんでした: {last}")


def http_json(url: str, **kwargs) -> Any:
    raw = http_get(url, **kwargs)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise FetchError(f"{url} からの応答が JSON ではありません") from exc


def chunked(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


# ---------------------------------------------------------------------------
# tiny on-disk cache
# ---------------------------------------------------------------------------

import hashlib  # noqa: E402
import os  # noqa: E402
from collections.abc import Callable  # noqa: E402
from pathlib import Path  # noqa: E402


def cache_dir() -> Path:
    base = os.environ.get("ECON_CAL_CACHE_DIR")
    path = Path(base) if base else Path.home() / ".cache" / "econ-calendar"
    path.mkdir(parents=True, exist_ok=True)
    return path


def cached_json(key: str, ttl_seconds: int, producer: Callable[[], Any]) -> Any:
    """Memoise a fetch on disk.

    Slow-moving upstream metadata (FRED's release list, for example) does not
    need re-fetching on every daily run, and a cache also keeps a scheduled job
    working through a brief upstream outage.
    """
    if ttl_seconds <= 0:
        return producer()
    path = cache_dir() / (hashlib.sha1(key.encode()).hexdigest()[:20] + ".json")
    try:
        if path.exists() and time.time() - path.stat().st_mtime < ttl_seconds:
            return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        log.debug("cache read failed for %s; refetching", key)

    value = producer()
    try:
        path.write_text(json.dumps(value), encoding="utf-8")
    except OSError:
        log.debug("cache write failed for %s", key)
    return value
