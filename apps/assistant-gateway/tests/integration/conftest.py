"""Integration fixtures: a real Postgres, skipped when TEST_DATABASE_URL is unset.

CI's database also carries the apps/api schema; the gateway only ever touches schema
``assistant_gateway``, which is dropped and rebuilt once per session, and only when the suite
itself created it (see ledger_schema).
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from typing import Any

import ledger_schema
import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo

from assistant_gateway import db


@pytest.fixture(scope="session")
def database_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "")
    if not url:
        pytest.skip("TEST_DATABASE_URL is not set")
    return url


@pytest.fixture(scope="session", autouse=True)
def _ledger_schema(database_url: str) -> None:
    """Rebuild the suite's schema assistant_gateway; stop the run if it is someone else's."""
    with db.connect(database_url, autocommit=True) as conn:
        try:
            ledger_schema.rebuild(conn)
        except ledger_schema.ForeignSchema as exc:
            pytest.exit(str(exc), returncode=1)


@pytest.fixture
def conn(database_url: str) -> Iterator[psycopg.Connection[Any]]:
    with db.connect(database_url, autocommit=True) as connection:
        yield connection


@pytest.fixture
def fresh_database_url(database_url: str) -> Iterator[str]:
    """A new, empty database on the test server; dropped afterwards."""
    name = f"ag_test_{uuid.uuid4().hex[:12]}"
    with db.connect(database_url, autocommit=True) as admin:
        admin.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    try:
        yield make_conninfo(database_url, dbname=name)
    finally:
        with db.connect(database_url, autocommit=True) as admin:
            admin.execute(
                sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(name))
            )
