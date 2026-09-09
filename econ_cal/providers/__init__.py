"""Provider registry."""

from __future__ import annotations

from ..config import Config
from .base import FetchContext, Provider
from .earnings import EarningsProvider
from .fomc import FomcProvider
from .fred import FredProvider
from .investing import InvestingProvider
from .market import MarketProvider
from .rules import RulesProvider

__all__ = [
    "FetchContext",
    "Provider",
    "build_providers",
    "EarningsProvider",
    "FomcProvider",
    "FredProvider",
    "InvestingProvider",
    "MarketProvider",
    "RulesProvider",
]


def build_providers(config: Config) -> list[Provider]:
    """Instantiate every provider the configuration switches on.

    Order matters only for logging; conflicts are resolved by
    ``SOURCE_PRIORITY`` when the results are merged.
    """
    providers: list[Provider] = []
    if config.provider_enabled("rules"):
        providers.append(RulesProvider())
    if config.provider_enabled("fomc"):
        providers.append(FomcProvider())
    if config.provider_enabled("market"):
        providers.append(MarketProvider())
    if config.provider_enabled("fred"):
        providers.append(
            FredProvider(api_key_env=config.get("providers.fred.api_key_env", "FRED_API_KEY"))
        )
    if config.provider_enabled("investing"):
        providers.append(
            InvestingProvider(
                timeout=config.get("providers.investing.timeout", 20),
                timezone_id=config.get("providers.investing.timezone_id", 55),
                assume_tz=config.get("providers.investing.assume_tz", "UTC"),
            )
        )
    if config.provider_enabled("earnings"):
        providers.append(
            EarningsProvider(
                tickers=config.get("providers.earnings.tickers", {}),
                timeout=config.get("providers.earnings.timeout", 20),
            )
        )
    return providers
