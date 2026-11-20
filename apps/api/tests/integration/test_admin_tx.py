"""admin_tx end to end: a verified admin token reaches Postgres as that admin, under RLS.

Skipped unless TEST_DATABASE_URL is set (CI always sets it).
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from typing import Annotated, Any

import psycopg
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from integration.helpers import NetworkFixture, drop_network, make_network
from jose import jwt

from connections_api import db
from connections_api.deps import admin_tx
from connections_api.errors import register_exception_handlers

DSN = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL is not set")


@pytest.fixture
def networks() -> Iterator[tuple[NetworkFixture, NetworkFixture]]:
    with db.connect(DSN, autocommit=True) as conn:
        mine, other = make_network(conn, name="Mine"), make_network(conn, name="Other")
        yield mine, other
        drop_network(conn, mine)
        drop_network(conn, other)


def test_admin_tx_runs_under_the_admins_claims_and_rls(
    networks: tuple[NetworkFixture, NetworkFixture],
) -> None:
    mine, other = networks
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/probe")
    def probe(conn: Annotated[psycopg.Connection[Any], Depends(admin_tx)]) -> dict[str, Any]:
        role, network_id = conn.execute("select current_user, current_network_id()").fetchone()  # type: ignore[misc]
        visible = conn.execute("select name from network order by name").fetchall()
        return {"role": role, "network_id": str(network_id), "visible": [r[0] for r in visible]}

    token = jwt.encode(
        {
            **mine.admin_claims,
            "aud": "authenticated",
            "iss": "http://localhost:54321/auth/v1",
            "exp": int(time.time()) + 3600,
        },
        "test-secret-value-not-used-anywhere-real",
        "HS256",
    )

    response = TestClient(app).get("/probe", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json() == {
        "role": "authenticated",
        "network_id": str(mine.network_id),
        "visible": ["Mine"],
    }
    assert other.network_id != mine.network_id
