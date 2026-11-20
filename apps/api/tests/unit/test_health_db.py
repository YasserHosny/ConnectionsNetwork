"""GET /api/v1/health/db: the keepalive target of the nightly backup workflow.

No auth and no database needed here: the connection is replaced, so both outcomes are covered
without Postgres. The real `select 1` against a database is in
tests/integration/test_health_db_integration.py.
"""

from __future__ import annotations

from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from connections_api import db
from connections_api.main import app


class _FakeConnection:
    def __init__(self) -> None:
        self.statements: list[str] = []

    def __enter__(self) -> _FakeConnection:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def execute(self, statement: str) -> _FakeConnection:
        self.statements.append(statement)
        return self

    def fetchone(self) -> tuple[int]:
        return (1,)


def test_health_db_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeConnection()
    calls: list[dict[str, Any]] = []

    def fake_connect(dsn: str | None = None, **kwargs: object) -> _FakeConnection:
        calls.append(kwargs)
        return fake

    monkeypatch.setattr(db, "connect", fake_connect)

    response = TestClient(app).get("/api/v1/health/db")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert fake.statements == ["select 1"]
    # A hung database must not hang the keepalive: a short connect timeout is always passed.
    assert calls == [{"connect_timeout": 5}]


def test_health_db_unavailable_does_not_leak_error_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def failing_connect(dsn: str | None = None, **kwargs: object) -> None:
        raise psycopg.OperationalError(
            'connection to server at "db.internal-host.example" (10.1.2.3), port 5432 failed'
        )

    monkeypatch.setattr(db, "connect", failing_connect)

    response = TestClient(app).get("/api/v1/health/db")

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
    assert "internal-host" not in response.text
    assert "10.1.2.3" not in response.text
    assert response.headers["X-Trace-Id"]


def test_health_db_needs_no_authentication(monkeypatch: pytest.MonkeyPatch) -> None:
    # No Authorization header, and no real connection attempted: exactly 200.
    monkeypatch.setattr(db, "connect", lambda dsn=None, **kwargs: _FakeConnection())

    response = TestClient(app).get("/api/v1/health/db")

    assert response.status_code == 200


def test_health_db_is_rate_limited_per_client(monkeypatch: pytest.MonkeyPatch) -> None:
    # Unauthenticated and opening a connection per call: it must not be a way to exhaust the
    # (Free plan) pooler. 30 a minute per client address; the 31st is refused.
    monkeypatch.setattr(db, "connect", lambda dsn=None, **kwargs: _FakeConnection())
    client = TestClient(app)

    statuses = [client.get("/api/v1/health/db").status_code for _ in range(31)]

    assert statuses == [200] * 30 + [429]
