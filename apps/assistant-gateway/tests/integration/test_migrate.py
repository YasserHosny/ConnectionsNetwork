from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import psycopg
import pytest

from assistant_gateway import db, migrate

INSERT_LEDGER = (
    "insert into assistant_gateway.ledger_entry "
    "(app, use_case, end_user_id, kind, model, status, reserved_usd) "
    "values ('a', 'u', 'e', %s, 'm', %s, 0)"
)


def test_apply_is_idempotent(conn: psycopg.Connection[Any]) -> None:
    # The session fixture already applied everything.
    assert migrate.apply(conn) == []
    assert migrate.pending(conn) == []


def test_applied_versions_are_filename_stems(conn: psycopg.Connection[Any]) -> None:
    rows = conn.execute("select version from assistant_gateway.schema_migrations").fetchall()
    assert ("0001_ledger",) in rows


def test_default_migrations_dir_holds_the_ledger_migration() -> None:
    assert (migrate.migrations_dir() / "0001_ledger.sql").is_file()


def test_connect_disables_prepared_statements(database_url: str) -> None:
    with db.connect(database_url, prepare_threshold=5) as c:
        assert c.prepare_threshold is None


def test_connect_defaults_to_configured_database_url() -> None:
    # conftest points AG_DATABASE_URL at TEST_DATABASE_URL when it is set.
    with db.connect() as c:
        assert c.execute("select 1").fetchone() == (1,)


def test_ledger_rejects_unknown_status(conn: psycopg.Connection[Any]) -> None:
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(INSERT_LEDGER, ("llm", "bogus"))


def test_ledger_rejects_unknown_kind(conn: psycopg.Connection[Any]) -> None:
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(INSERT_LEDGER, ("video", "reserved"))


@pytest.mark.parametrize("status", ["reserved", "settled", "released", "expired", "unknown"])
@pytest.mark.parametrize("kind", ["llm", "speech"])
def test_ledger_accepts_every_documented_status_and_kind(
    conn: psycopg.Connection[Any], kind: str, status: str
) -> None:
    with conn.transaction():
        conn.execute(INSERT_LEDGER, (kind, status))
        raise psycopg.Rollback


def test_ledger_row_gets_id_and_created_at_defaults(conn: psycopg.Connection[Any]) -> None:
    with conn.transaction():
        row = conn.execute(
            INSERT_LEDGER + " returning id, created_at, settled_at, actual_usd", ("llm", "reserved")
        ).fetchone()
        assert row is not None
        entry_id, created_at, settled_at, actual_usd = row
        assert entry_id is not None
        assert created_at is not None
        assert settled_at is None
        assert actual_usd is None
        raise psycopg.Rollback


def test_ledger_money_is_six_decimal_places(conn: psycopg.Connection[Any]) -> None:
    with conn.transaction():
        row = conn.execute(
            "insert into assistant_gateway.ledger_entry "
            "(app, use_case, end_user_id, kind, model, status, reserved_usd) "
            "values ('a', 'u', 'e', 'llm', 'm', 'reserved', 0.1234565) returning reserved_usd"
        ).fetchone()
        assert row is not None
        assert str(row[0]) == "0.123457"
        raise psycopg.Rollback


def test_ledger_indexes(conn: psycopg.Connection[Any]) -> None:
    rows = conn.execute(
        "select indexdef from pg_indexes "
        "where schemaname = 'assistant_gateway' and tablename = 'ledger_entry'"
    ).fetchall()
    defs = [r[0] for r in rows]
    assert any("(app, created_at)" in d and "WHERE" not in d for d in defs)
    assert any(
        "(app, status, created_at)" in d and "WHERE" in d and "'reserved'" in d for d in defs
    )


def test_pending_lists_unrecorded_files_in_name_order(
    conn: psycopg.Connection[Any], tmp_path: Path
) -> None:
    (tmp_path / "9002_b.sql").write_text("select 1")
    (tmp_path / "9001_a.sql").write_text("select 1")
    (tmp_path / "notes.txt").write_text("not a migration")
    assert migrate.pending(conn, tmp_path) == ["9001_a", "9002_b"]


def test_failed_migration_rolls_back_and_is_not_recorded(
    conn: psycopg.Connection[Any], tmp_path: Path
) -> None:
    (tmp_path / "9010_bad.sql").write_text(
        "create table assistant_gateway.rollback_probe (id int); select 1/0;"
    )
    with pytest.raises(psycopg.errors.DivisionByZero):
        migrate.apply(conn, tmp_path)
    probe = conn.execute("select to_regclass('assistant_gateway.rollback_probe')").fetchone()
    assert probe == (None,)
    assert migrate.pending(conn, tmp_path) == ["9010_bad"]


def test_earlier_migrations_stay_applied_when_a_later_one_fails(
    conn: psycopg.Connection[Any], tmp_path: Path
) -> None:
    (tmp_path / "9020_ok.sql").write_text("create table assistant_gateway.each_tx_probe (id int)")
    (tmp_path / "9021_bad.sql").write_text("select 1/0")
    try:
        with pytest.raises(psycopg.errors.DivisionByZero):
            migrate.apply(conn, tmp_path)
        assert migrate.pending(conn, tmp_path) == ["9021_bad"]
    finally:
        conn.execute("drop table if exists assistant_gateway.each_tx_probe")
        conn.execute("delete from assistant_gateway.schema_migrations where version = '9020_ok'")


def test_concurrent_runners_apply_a_migration_exactly_once(
    database_url: str, conn: psycopg.Connection[Any], tmp_path: Path
) -> None:
    (tmp_path / "9100_race.sql").write_text(
        "create table assistant_gateway.race_probe (id int); select pg_sleep(0.3)"
    )
    results: list[list[str]] = []
    errors: list[BaseException] = []

    def run() -> None:
        try:
            with db.connect(database_url, autocommit=True) as c:
                results.append(migrate.apply(c, tmp_path))
        except BaseException as exc:  # noqa: BLE001 - surfaced by the assertion below
            errors.append(exc)

    threads = [threading.Thread(target=run) for _ in range(4)]
    try:
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert errors == []
        assert sorted(results) == [[], [], [], ["9100_race"]]
    finally:
        conn.execute("drop table if exists assistant_gateway.race_probe")
        conn.execute("delete from assistant_gateway.schema_migrations where version = '9100_race'")
