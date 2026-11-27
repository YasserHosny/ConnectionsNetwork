from __future__ import annotations

from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import psycopg
import pytest
from fastapi.testclient import TestClient

from assistant_gateway import db
from assistant_gateway.ledger import Caps, reserve, settle

Q = {"use_case": "person_add", "end_user_id": "user-1"}


@pytest.fixture(autouse=True)
def _empty_ledger(database_url: str) -> None:
    with db.connect(database_url, autocommit=True) as c:
        c.execute("truncate assistant_gateway.ledger_entry")


def _spend(conn: psycopg.Connection[Any], amount: str) -> None:
    """Settle `amount` USD against the connections app."""
    entry = reserve(
        conn,
        app="connections",
        use_case="person_add",
        end_user_id="user-1",
        kind="llm",
        model="claude-haiku-4-5",
        amount=Decimal(amount),
        caps=Caps(Decimal("100"), None, None),
        tz=ZoneInfo("Africa/Cairo"),
    )
    settle(conn, entry, actual_usd=Decimal(amount))


def test_status_requires_a_known_key(client: TestClient) -> None:
    assert client.get("/v1/status", params=Q).status_code == 401
    r = client.get("/v1/status", params=Q, headers={"Authorization": "Bearer wrong"})
    assert r.json()["code"] == "auth.unauthenticated"


@pytest.mark.parametrize("end_user_id", ["u\x00x", "u\nx", ""])
def test_status_rejects_control_characters_in_the_end_user_id(
    client: TestClient, auth: dict[str, str], end_user_id: str
) -> None:
    r = client.get("/v1/status", params={**Q, "end_user_id": end_user_id}, headers=auth)
    assert r.status_code == 422
    assert r.json()["code"] == "validation.invalid_request"


def test_status_with_no_spend(client: TestClient, auth: dict[str, str]) -> None:
    body = client.get("/v1/status", params=Q, headers=auth).json()
    assert body["budget"] == {"used_usd": 0.0, "cap_usd": 5.0, "warning": False, "exhausted": False}
    assert body["available"] is True


def test_status_reports_mode_and_budget(
    client: TestClient, auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    _spend(conn, "4.10")  # of 5.00
    r = client.get("/v1/status", params=Q, headers=auth)
    assert r.status_code == 200
    assert r.json() == {
        "speech": {"mode": "browser", "language": "ar-EG"},
        "available": True,
        "budget": {"used_usd": 4.1, "cap_usd": 5.0, "warning": True, "exhausted": False},
    }


def test_status_unavailable_when_budget_exhausted(
    client: TestClient, auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    _spend(conn, "5.00")
    body = client.get("/v1/status", params=Q, headers=auth).json()
    assert body["available"] is False
    assert body["budget"]["exhausted"] is True


def test_status_is_scoped_to_the_calling_app(
    client: TestClient, other_auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    _spend(conn, "4.10")  # the connections app's spend
    body = client.get("/v1/status", params=Q, headers=other_auth).json()
    assert body["budget"]["used_usd"] == 0.0


def test_rate_limit_is_per_app_key(
    client: TestClient, auth: dict[str, str], other_auth: dict[str, str]
) -> None:
    for _ in range(60):
        assert client.get("/v1/status", params=Q, headers=auth).status_code == 200
    r = client.get("/v1/status", params=Q, headers=auth)
    assert r.status_code == 429
    assert r.json()["code"] == "rate_limited"
    assert set(r.json()) == {"code", "message", "details", "trace_id"}
    assert client.get("/v1/status", params=Q, headers=other_auth).status_code == 200


@pytest.mark.parametrize(
    ("path", "params"),
    [("/v1/status", Q), ("/v1/usage", {"period": "2026-11"})],
)
def test_a_rate_limited_request_opens_no_database_connection(
    client: TestClient,
    auth: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    params: dict[str, str],
) -> None:
    opened: list[None] = []
    real_connect = db.connect

    def counting_connect(*args: Any, **kwargs: Any) -> psycopg.Connection[Any]:  # noqa: ANN401
        opened.append(None)
        return real_connect(*args, **kwargs)

    # Both places a route can open one from: the dependency in db, and routes.common.
    monkeypatch.setattr("assistant_gateway.db.connect", counting_connect)
    monkeypatch.setattr("assistant_gateway.routes.common.connect", counting_connect)
    for _ in range(60):
        assert client.get(path, params=params, headers=auth).status_code == 200
    assert opened  # the admitted requests did use the database
    opened.clear()
    r = client.get(path, params=params, headers=auth)
    assert r.status_code == 429
    assert opened == []
