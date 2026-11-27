"""Apply the SQL files in ``migrations/`` to schema ``assistant_gateway``.

A migration's version is its filename stem (``0001_ledger``). Files apply in name order, each in
its own transaction, and are recorded in ``assistant_gateway.schema_migrations``. Run with
``python -m assistant_gateway.migrate`` (uses AG_DATABASE_URL).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import psycopg

from assistant_gateway import db

# Held for the length of every migration transaction, so concurrent runners take turns.
_LOCK = "select pg_advisory_xact_lock(hashtextextended('assistant_gateway:migrate', 0))"


def migrations_dir() -> Path:
    """Where the SQL files live.

    An installed wheel carries them inside the package (hatch force-include); a source or
    editable checkout keeps them in ``migrations/`` beside ``src/``.
    """
    package = Path(__file__).parent
    for candidate in (package / "migrations", package.parents[1] / "migrations"):
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("assistant_gateway migrations directory not found")


def _files(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.sql"), key=lambda path: path.name)


def _applied(conn: psycopg.Connection[Any]) -> set[str]:
    exists = conn.execute("select to_regclass('assistant_gateway.schema_migrations')").fetchone()
    if exists is None or exists[0] is None:
        return set()
    rows = conn.execute("select version from assistant_gateway.schema_migrations").fetchall()
    return {row[0] for row in rows}


def pending(conn: psycopg.Connection[Any], directory: Path | None = None) -> list[str]:
    """Versions on disk that are not yet recorded as applied, in order."""
    applied = _applied(conn)
    return [p.stem for p in _files(directory or migrations_dir()) if p.stem not in applied]


def apply(conn: psycopg.Connection[Any], directory: Path | None = None) -> list[str]:
    """Apply every pending migration; return the versions applied by this call.

    The connection must not be inside a transaction already (use ``autocommit=True``), so each
    migration commits on its own.
    """
    with conn.transaction():
        conn.execute(_LOCK)
        conn.execute("create schema if not exists assistant_gateway")
        conn.execute(
            "create table if not exists assistant_gateway.schema_migrations ("
            "version text primary key, applied_at timestamptz not null default now())"
        )
    applied_now: list[str] = []
    for path in _files(directory or migrations_dir()):
        with conn.transaction():
            conn.execute(_LOCK)
            # Re-read under the lock: another runner may have applied it while this one waited.
            if path.stem in _applied(conn):
                continue
            conn.execute(path.read_text())
            conn.execute(
                "insert into assistant_gateway.schema_migrations (version) values (%s)",
                (path.stem,),
            )
            applied_now.append(path.stem)
    return applied_now


def main() -> None:
    with db.connect(autocommit=True) as conn:
        versions = apply(conn)
    if versions:
        print("applied: " + ", ".join(versions))
    else:
        print("no pending migrations")


if __name__ == "__main__":
    main()
