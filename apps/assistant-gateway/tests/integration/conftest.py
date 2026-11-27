"""Integration fixtures: a real Postgres, skipped when TEST_DATABASE_URL is unset.

CI's database also carries the apps/api schema; the gateway only ever touches schema
``assistant_gateway``, which is dropped and rebuilt once per session.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest

from assistant_gateway import db, migrate


@pytest.fixture(scope="session")
def database_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "")
    if not url:
        pytest.skip("TEST_DATABASE_URL is not set")
    return url


@pytest.fixture(scope="session", autouse=True)
def _ledger_schema(database_url: str) -> None:
    """Drop and recreate schema assistant_gateway, then apply every migration."""
    with db.connect(database_url, autocommit=True) as conn:
        conn.execute("drop schema if exists assistant_gateway cascade")
        migrate.apply(conn)


@pytest.fixture
def conn(database_url: str) -> Iterator[psycopg.Connection[Any]]:
    with db.connect(database_url, autocommit=True) as connection:
        yield connection
