"""JwksCache refresh behaviour when the identity provider is failing.

A refresh runs under the cache's lock with a 5s timeout, so every request that triggers one waits
behind it. While the JWKS endpoint is down, requests must keep verifying against the cached keys
and retry the fetch at most once per refresh interval, not once per request.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from connections_api.config import get_settings
from connections_api.modules.auth import jwks as jwks_module
from connections_api.modules.auth.jwks import JwksCache, JwksUnavailableError

KEY = {"kty": "EC", "crv": "P-256", "alg": "ES256", "kid": "key-1", "x": "x", "y": "y"}


class Provider:
    """A JWKS endpoint that can be switched between serving keys and failing."""

    def __init__(self) -> None:
        self.calls = 0
        self.failing = False

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.failing:
            return httpx.Response(503)
        return httpx.Response(200, json={"keys": [KEY]})


@pytest.fixture
def provider() -> Provider:
    return Provider()


@pytest.fixture
def cache(provider: Provider) -> JwksCache:
    client = httpx.Client(transport=httpx.MockTransport(provider.handle))
    return JwksCache(get_settings(), client=client)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> dict[str, float]:
    now = {"t": 10_000.0}
    monkeypatch.setattr(jwks_module.time, "monotonic", lambda: now["t"])
    return now


def test_a_failing_provider_is_retried_at_most_once_per_interval_while_keys_are_stale(
    cache: JwksCache, provider: Provider, clock: dict[str, float]
) -> None:
    assert cache.get_key("key-1") == KEY
    assert provider.calls == 1

    clock["t"] += jwks_module.CACHE_TTL_SECONDS + 1  # the cached set is now stale
    provider.failing = True

    results: list[dict[str, Any] | None] = [cache.get_key("key-1") for _ in range(3)]

    assert results == [KEY, KEY, KEY]  # cached keys keep serving
    assert provider.calls == 2  # one retry, not one per request


def test_a_stale_cache_retries_again_once_the_interval_has_passed(
    cache: JwksCache, provider: Provider, clock: dict[str, float]
) -> None:
    cache.get_key("key-1")
    clock["t"] += jwks_module.CACHE_TTL_SECONDS + 1
    provider.failing = True
    cache.get_key("key-1")
    assert provider.calls == 2

    clock["t"] += jwks_module.MIN_REFRESH_INTERVAL_SECONDS + 1
    provider.failing = False
    cache.get_key("key-1")

    assert provider.calls == 3


def test_with_no_keys_at_all_a_failing_provider_is_not_hammered(
    cache: JwksCache, provider: Provider, clock: dict[str, float]
) -> None:
    provider.failing = True

    for _ in range(3):
        with pytest.raises(JwksUnavailableError):
            cache.get_key("key-1")

    assert provider.calls == 1
