"""The session fixture rebuilds schema assistant_gateway only when the suite created it."""

from __future__ import annotations

import ledger_schema
import pytest

from assistant_gateway import db, migrate


def _has(url: str, regclass: str) -> bool:
    with db.connect(url, autocommit=True) as conn:
        row = conn.execute("select to_regclass(%s)", (regclass,)).fetchone()
    return row is not None and row[0] is not None


def test_an_absent_schema_is_created_marked_and_migrated(fresh_database_url: str) -> None:
    with db.connect(fresh_database_url, autocommit=True) as conn:
        ledger_schema.rebuild(conn)
        assert migrate.pending(conn) == []
    assert _has(fresh_database_url, ledger_schema.MARKER)


def test_a_schema_the_suite_did_not_create_is_refused_and_kept(fresh_database_url: str) -> None:
    with db.connect(fresh_database_url, autocommit=True) as conn:
        # What a real gateway database looks like: migrated, with a ledger, and no marker.
        migrate.apply(conn)
        conn.execute("create table assistant_gateway.precious (id int)")
        with pytest.raises(ledger_schema.ForeignSchema, match="Refusing to drop it"):
            ledger_schema.rebuild(conn)
    assert _has(fresh_database_url, "assistant_gateway.precious")
    assert _has(fresh_database_url, "assistant_gateway.ledger_entry")


def test_the_suites_own_schema_is_dropped_and_rebuilt(fresh_database_url: str) -> None:
    with db.connect(fresh_database_url, autocommit=True) as conn:
        ledger_schema.rebuild(conn)
        conn.execute("create table assistant_gateway.leftover (id int)")
        ledger_schema.rebuild(conn)
        assert migrate.pending(conn) == []
    assert not _has(fresh_database_url, "assistant_gateway.leftover")
    assert _has(fresh_database_url, ledger_schema.MARKER)


def test_the_session_schema_carries_the_marker(database_url: str) -> None:
    assert _has(database_url, ledger_schema.MARKER)
