"""Provider protocol and the context handed to every provider."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Protocol
from zoneinfo import ZoneInfo

from ..catalog import Catalog
from ..config import Config
from ..models import EconEvent


@dataclass(frozen=True)
class FetchContext:
    """Everything a provider needs, so providers stay free of global state."""

    start: date
    end: date
    catalog: Catalog
    config: Config
    tz: ZoneInfo


class Provider(Protocol):
    name: str

    def fetch(self, ctx: FetchContext) -> list[EconEvent]:
        """Return every event this source knows about in ``[start, end]``.

        Providers must not raise for an empty result; they may raise
        :class:`~econ_cal.util.FetchError` when the upstream is unreachable, and
        the collector downgrades that to a warning so one dead source cannot
        take the whole sync down.
        """
        ...
