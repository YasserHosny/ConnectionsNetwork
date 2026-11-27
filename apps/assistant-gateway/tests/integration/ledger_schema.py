"""The integration suite's own schema ``assistant_gateway``, and the guard on whose it is.

The suite drops and rebuilds the schema, so it must never do that to a schema it did not create:
a ``TEST_DATABASE_URL`` pointed by mistake at a real gateway database would lose its ledger. The
schema the suite builds carries a marker table, and a schema without one is refused, untouched.
"""

from __future__ import annotations

from typing import Any

import psycopg

from assistant_gateway import migrate

MARKER = "assistant_gateway._pytest_fixture_marker"


class ForeignSchema(Exception):
    """Schema assistant_gateway exists, and the test suite did not create it."""


def rebuild(conn: psycopg.Connection[Any]) -> None:
    """Drop the suite's own schema if present, then create it afresh and apply every migration.

    Raises ForeignSchema, changing nothing, when the schema exists without the suite's marker.
    """
    present = conn.execute(
        "select 1 from pg_namespace where nspname = 'assistant_gateway'"
    ).fetchone()
    if present is not None:
        marked = conn.execute("select to_regclass(%s)", (MARKER,)).fetchone()
        if marked is None or marked[0] is None:
            raise ForeignSchema(
                "TEST_DATABASE_URL holds a schema assistant_gateway that the test suite did not "
                f"create (no {MARKER} table). Refusing to drop it: point TEST_DATABASE_URL at a "
                "disposable test database, or drop that schema yourself if it is a stale one."
            )
        conn.execute("drop schema assistant_gateway cascade")
    with conn.transaction():
        conn.execute("create schema assistant_gateway")
        conn.execute(f"create table {MARKER} ()")
    migrate.apply(conn)
