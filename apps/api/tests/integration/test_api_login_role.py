"""The API's own database login, `connections_api` (20261119000009_api_login_role.sql, ruling R19).

The API must not connect as the database owner: the owner bypasses row-level security, so one
query that escaped `user_tx` would read every network. `connections_api` holds no table
privilege at all; it can only switch to `authenticated` (user_tx) or `contributor_api`
(contributor_tx), and RLS applies to both.

The role is NOLOGIN in the migration (the owner enables LOGIN with a password at deploy). The
fixture below does the same in the throwaway test database and undoes it afterwards.

Skipped unless TEST_DATABASE_URL is set (CI always sets it).
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from integration.helpers import NetworkFixture, drop_network, make_network
from psycopg import errors, sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from connections_api import db

DSN = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL is not set")

# A throwaway password for the throwaway test database; set and cleared by the fixture.
TEST_PASSWORD = "connections-api-test-only"


@pytest.fixture
def conn() -> Iterator[psycopg.Connection[Any]]:
    with db.connect(DSN, autocommit=True) as connection:
        yield connection


@pytest.fixture
def network(conn: psycopg.Connection[Any]) -> Iterator[NetworkFixture]:
    fixture = make_network(conn)
    yield fixture
    drop_network(conn, fixture)


@pytest.fixture
def api_dsn(conn: psycopg.Connection[Any]) -> Iterator[str]:
    """A DSN that logs in as connections_api, as the deployed API does."""
    conn.execute(f"alter role connections_api login password '{TEST_PASSWORD}'")
    params = conninfo_to_dict(DSN)
    params.update(user="connections_api", password=TEST_PASSWORD)
    try:
        yield make_conninfo(**params)
    finally:
        conn.execute("alter role connections_api nologin password null")


def test_the_role_cannot_bypass_rls_or_inherit(conn: psycopg.Connection[Any]) -> None:
    row = conn.execute(
        "select rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb"
        " from pg_roles where rolname = 'connections_api'"
    ).fetchone()
    assert row == (False, False, False, False, False, False)

    can_set = conn.execute(
        "select r, pg_has_role('connections_api', r, 'SET'),"
        "       pg_has_role('connections_api', r, 'USAGE')"
        " from unnest(array['authenticated', 'contributor_api', 'anon', 'service_role',"
        "                   'postgres']) r"
    ).fetchall()
    assert can_set == [
        ("authenticated", True, False),
        ("contributor_api", True, False),
        ("anon", False, False),
        ("service_role", False, False),
        ("postgres", False, False),
    ]


def test_user_tx_works_under_rls(api_dsn: str, network: NetworkFixture) -> None:
    with db.user_tx(network.admin_claims, dsn=api_dsn) as tx:
        assert tx.execute("select current_user, session_user").fetchone() == (
            "authenticated",
            "connections_api",
        )
        ids = {row[0] for row in tx.execute("select id from person")}

    assert ids == {network.admin_person_id}


def test_contributor_tx_works(api_dsn: str) -> None:
    unknown = hashlib.sha256(b"not a real link").digest()

    with db.contributor_tx(dsn=api_dsn) as tx:
        assert tx.execute("select current_user").fetchone() == ("contributor_api",)
        rows = tx.execute("select * from public.contributor_link_info(%s)", (unknown,)).fetchall()

    assert rows == []


def test_health_check_query_works(api_dsn: str) -> None:
    with db.connect(api_dsn) as plain:
        assert plain.execute("select 1").fetchone() == (1,)


def test_without_the_role_switch_no_table_is_readable(
    api_dsn: str, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    tables = [
        row[0]
        for row in conn.execute("select tablename from pg_tables where schemaname = 'public'")
    ]
    assert tables
    for table in tables:
        with db.connect(api_dsn) as plain, pytest.raises(errors.InsufficientPrivilege):
            plain.execute(sql.SQL("select 1 from {}").format(sql.Identifier(table)))


@pytest.mark.parametrize("role", ["postgres", "service_role", "anon"])
def test_cannot_become_another_role(api_dsn: str, role: str) -> None:
    with db.connect(api_dsn) as plain, pytest.raises(errors.InsufficientPrivilege):
        plain.execute(sql.SQL("set role {}").format(sql.Identifier(role)))
