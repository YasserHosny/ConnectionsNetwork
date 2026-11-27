from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import psycopg
import pytest
from fastapi.testclient import TestClient
from httpx import Response

from assistant_gateway import db, ledger

# Mid-November 2026 in Cairo (UTC+2).
NOV = datetime(2026, 11, 15, 10, 0, tzinfo=UTC)

_INSERT = """
insert into assistant_gateway.ledger_entry
    (app, use_case, end_user_id, kind, model, status, reserved_usd, actual_usd,
     input_tokens, output_tokens, audio_seconds, created_at)
values (%(app)s, %(use_case)s, %(user)s, %(kind)s, 'm', %(status)s, %(reserved)s, %(actual)s,
        %(input)s, %(output)s, %(audio)s, %(at)s)
"""


@pytest.fixture(autouse=True)
def _empty_ledger(database_url: str) -> None:
    with db.connect(database_url, autocommit=True) as c:
        c.execute("truncate assistant_gateway.ledger_entry")


def _row(
    conn: psycopg.Connection[Any],
    *,
    status: str,
    reserved: str,
    actual: str | None = None,
    app: str = "connections",
    use_case: str = "person_add",
    user: str = "user-1",
    kind: str = "llm",
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    audio: str | None = None,
    at: datetime = NOV,
) -> None:
    conn.execute(
        _INSERT,
        {
            "app": app,
            "use_case": use_case,
            "user": user,
            "kind": kind,
            "status": status,
            "reserved": Decimal(reserved),
            "actual": Decimal(actual) if actual is not None else None,
            "input": input_tokens,
            "output": output_tokens,
            "audio": Decimal(audio) if audio is not None else None,
            "at": at,
        },
    )


def _get(client: TestClient, auth: dict[str, str], period: str = "2026-11") -> Response:
    return client.get("/v1/usage", params={"period": period}, headers=auth)


def test_usage_requires_a_known_key(client: TestClient) -> None:
    assert client.get("/v1/usage", params={"period": "2026-11"}).status_code == 401


def test_usage_groups_and_scopes_to_app(
    client: TestClient, auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    _row(
        conn,
        status="settled",
        reserved="0.020000",
        actual="0.010000",
        user="user-1",
        input_tokens=100,
        output_tokens=20,
    )
    _row(
        conn,
        status="settled",
        reserved="0.030000",
        actual="0.020000",
        user="user-2",
        input_tokens=50,
        output_tokens=5,
    )
    _row(conn, status="reserved", reserved="0.040000", use_case="eval", user="user-1")
    _row(conn, status="unknown", reserved="0.010000", use_case="eval", user="user-2")
    _row(
        conn,
        status="settled",
        reserved="0.002000",
        actual="0.001500",
        kind="speech",
        user="user-1",
        audio="12.50",
    )
    _row(conn, status="settled", reserved="9", actual="9", app="other-app", user="other-app-user")

    r = _get(client, auth)

    assert r.status_code == 200
    body = r.json()
    assert body["period"] == "2026-11"
    assert body["app"] == "connections"
    assert body["settled_usd"] == 0.0315
    assert body["reserved_usd"] == 0.05
    assert body["by_use_case"] == [
        {
            "use_case": "eval",
            "kind": "llm",
            "calls": 2,
            "input_tokens": 0,
            "output_tokens": 0,
            "audio_seconds": 0.0,
            "settled_usd": 0.0,
            "reserved_usd": 0.05,
        },
        {
            "use_case": "person_add",
            "kind": "llm",
            "calls": 2,
            "input_tokens": 150,
            "output_tokens": 25,
            "audio_seconds": 0.0,
            "settled_usd": 0.03,
            "reserved_usd": 0.0,
        },
        {
            "use_case": "person_add",
            "kind": "speech",
            "calls": 1,
            "input_tokens": 0,
            "output_tokens": 0,
            "audio_seconds": 12.5,
            "settled_usd": 0.0015,
            "reserved_usd": 0.0,
        },
    ]
    assert body["by_end_user"] == [
        {"end_user_id": "user-1", "calls": 3, "settled_usd": 0.0115, "reserved_usd": 0.04},
        {"end_user_id": "user-2", "calls": 2, "settled_usd": 0.02, "reserved_usd": 0.01},
    ]


def test_usage_counts_released_calls_but_not_their_cost(
    client: TestClient, auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    _row(conn, status="released", reserved="0.500000")
    _row(conn, status="settled", reserved="0.100000", actual="0.020000")
    body = _get(client, auth).json()
    assert body["settled_usd"] == 0.02
    assert body["reserved_usd"] == 0.0
    assert body["by_use_case"][0]["calls"] == 2
    assert body["by_end_user"][0]["calls"] == 2


def test_usage_puts_reserved_expired_and_unknown_under_reserved_usd(
    client: TestClient, auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    _row(conn, status="reserved", reserved="0.010000")
    _row(conn, status="expired", reserved="0.020000")
    _row(conn, status="unknown", reserved="0.040000")
    body = _get(client, auth).json()
    assert body["settled_usd"] == 0.0
    assert body["reserved_usd"] == 0.07


def test_usage_for_an_empty_month(client: TestClient, auth: dict[str, str]) -> None:
    assert _get(client, auth, "2026-09").json() == {
        "period": "2026-09",
        "app": "connections",
        "settled_usd": 0.0,
        "reserved_usd": 0.0,
        "by_use_case": [],
        "by_end_user": [],
    }


def test_usage_month_runs_in_the_apps_timezone(
    client: TestClient, auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    # Cairo is UTC+2 on 1 Nov, so November there starts at 22:00 UTC on 31 Oct and ends at
    # 22:00 UTC on 30 Nov.
    _row(
        conn,
        status="settled",
        reserved="1",
        actual="1",
        at=datetime(2026, 10, 31, 21, 59, 59, tzinfo=UTC),
    )  # October (Cairo)
    _row(
        conn,
        status="settled",
        reserved="2",
        actual="2",
        at=datetime(2026, 10, 31, 22, 0, tzinfo=UTC),
    )  # first moment of November
    _row(
        conn,
        status="settled",
        reserved="4",
        actual="4",
        at=datetime(2026, 11, 30, 21, 59, 59, tzinfo=UTC),
    )  # last moment of November
    _row(
        conn,
        status="settled",
        reserved="8",
        actual="8",
        at=datetime(2026, 11, 30, 22, 0, tzinfo=UTC),
    )  # December (Cairo)

    assert _get(client, auth, "2026-11").json()["settled_usd"] == 6.0
    assert _get(client, auth, "2026-10").json()["settled_usd"] == 1.0
    assert _get(client, auth, "2026-12").json()["settled_usd"] == 8.0


def test_usage_matches_ledger_report_in_the_apps_timezone(
    conn: psycopg.Connection[Any],
) -> None:
    _row(conn, status="settled", reserved="3", actual="2")
    report = ledger.usage_report(
        conn, app="connections", period="2026-11", tz=ZoneInfo("Africa/Cairo")
    )
    assert report.settled_usd == Decimal("2")
    assert report.by_use_case[0].calls == 1


@pytest.mark.parametrize("period", ["2026-13", "2026-00", "2026-1", "202611", "nov", "2026-11-01"])
def test_usage_rejects_an_invalid_period(
    client: TestClient, auth: dict[str, str], period: str
) -> None:
    r = _get(client, auth, period)
    assert r.status_code == 422
    assert r.json()["code"] == "invalid_period"
    assert set(r.json()) == {"code", "message", "details", "trace_id"}


def test_usage_needs_a_period(client: TestClient, auth: dict[str, str]) -> None:
    r = client.get("/v1/usage", headers=auth)
    assert r.status_code == 422
    assert set(r.json()) == {"code", "message", "details", "trace_id"}


def test_usage_rate_limit_is_per_app_key(
    client: TestClient, auth: dict[str, str], other_auth: dict[str, str]
) -> None:
    for _ in range(60):
        assert _get(client, auth).status_code == 200
    assert _get(client, auth).status_code == 429
    assert _get(client, other_auth).status_code == 200
