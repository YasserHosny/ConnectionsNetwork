"""The per-address rate limits key on the visitor without the visitor's address reaching a log."""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from connections_api import db
from connections_api.main import app
from connections_api.shared.rate_limit import client_address_key

# Short enough to slip past the log redactor's digit-run rule (8 or more digits), as most IPv4
# and all IPv6 addresses do.
VISITOR = "192.0.2.1"


class _FakeConnection:
    def __enter__(self) -> _FakeConnection:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def execute(self, _statement: str) -> _FakeConnection:
        return self

    def fetchone(self) -> tuple[int]:
        return (1,)


def _from(address: str) -> ASGIApp:
    """The app as seen from `address` (TestClient always reports "testclient")."""

    async def asgi(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            scope = {**scope, "client": (address, 50000)}
        await app(scope, receive, send)

    return asgi


def _request(address: str) -> Request:
    return Request({"type": "http", "client": (address, 50000), "headers": []})


@pytest.mark.parametrize("address", [VISITOR, "2001:db8::5"])
def test_exceeding_the_per_address_limit_logs_no_address(
    address: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # SlowAPI logs the bucket key when a limit is exceeded; behind the CDN that key is the
    # visitor's address, which must not reach the container log.
    monkeypatch.setattr(db, "connect", lambda dsn=None, **kwargs: _FakeConnection())
    client = TestClient(_from(address))

    with caplog.at_level(logging.DEBUG):
        statuses = [client.get("/api/v1/health/db").status_code for _ in range(31)]

    assert statuses[-1] == 429
    assert "exceeded" in caplog.text  # the warning was emitted, so the check below means something
    assert address not in caplog.text


def test_client_address_key_is_stable_and_distinct_per_address() -> None:
    first = client_address_key(_request(VISITOR))
    assert client_address_key(_request(VISITOR)) == first
    assert client_address_key(_request("198.51.100.24")) != first
    assert VISITOR not in first
    assert client_address_key(_request("2001:db8::5")) != first
