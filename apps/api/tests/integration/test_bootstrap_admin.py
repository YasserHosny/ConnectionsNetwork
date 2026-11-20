"""scripts/bootstrap_admin.py: the first admin's network, person and member, created once.

The script runs as the database owner (outside RLS), so the test connects as the superuser
and reads back through the same connection.

Skipped unless TEST_DATABASE_URL is set (CI always sets it).
"""

from __future__ import annotations

import importlib.util
import os
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any
from uuid import uuid4

import psycopg
import pytest

from connections_api.db import connect

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "bootstrap_admin.py"
DSN = os.environ.get("TEST_DATABASE_URL", "postgresql://postgres:postgres@localhost:54329/postgres")


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("bootstrap_admin", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves string annotations through sys.modules.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def conn() -> Iterator[psycopg.Connection[Any]]:
    with connect(DSN, autocommit=True) as connection:
        yield connection


@pytest.fixture
def admin_user(conn: psycopg.Connection[Any]) -> Iterator[tuple[str, str]]:
    """An auth.users row, as the Supabase dashboard would have created it. Returns (id, email)."""
    user_id = str(uuid4())
    email = f"Boot-{user_id}@Example.test"
    conn.execute("insert into auth.users (id, email) values (%s, %s)", (user_id, email))
    yield user_id, email
    conn.execute(
        "delete from network where id in (select network_id from member where user_id = %s)",
        (user_id,),
    )
    conn.execute("delete from auth.users where id = %s", (user_id,))


def counts(conn: psycopg.Connection[Any], user_id: str) -> tuple[int, int, int]:
    row = conn.execute(
        """
        select (select count(*) from network n where n.id in
                  (select network_id from member where user_id = %(u)s)),
               (select count(*) from member where user_id = %(u)s),
               (select count(*) from person p where p.id in
                  (select person_id from member where user_id = %(u)s))
        """,
        {"u": user_id},
    ).fetchone()
    assert row is not None
    return row


def test_bootstrap_creates_once(conn: psycopg.Connection[Any], admin_user: tuple[str, str]) -> None:
    script = load_script()
    user_id, email = admin_user

    first = script.bootstrap_admin(
        conn, email=email, name_ar="مدير", name_latin="Admin", network_name="Family"
    )
    second = script.bootstrap_admin(
        conn, email=email, name_ar="مدير", name_latin="Admin", network_name="Family"
    )

    assert first.created is True
    assert second.created is False
    assert second.network_id == first.network_id
    assert counts(conn, user_id) == (1, 1, 1)

    row = conn.execute(
        "select m.role, m.status, n.name, p.name_ar, p.name_latin"
        " from member m join network n on n.id = m.network_id"
        " join person p on p.id = m.person_id where m.user_id = %s",
        (user_id,),
    ).fetchone()
    assert row == ("admin", "active", "Family", "مدير", "Admin")


def test_bootstrap_unknown_email_raises_and_writes_nothing(
    conn: psycopg.Connection[Any],
) -> None:
    script = load_script()
    before = conn.execute("select count(*) from network").fetchone()

    with pytest.raises(script.UserNotFoundError, match="nobody@example.test"):
        script.bootstrap_admin(conn, email="nobody@example.test", name_ar="س")

    assert conn.execute("select count(*) from network").fetchone() == before


def test_main_exits_nonzero_with_a_clear_message_when_user_missing(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    script = load_script()
    monkeypatch.setenv("DATABASE_URL", DSN)

    code = script.main(["--email", "nobody@example.test", "--name-ar", "س"])

    assert code == 1
    assert "nobody@example.test" in capsys.readouterr().err


def test_main_prints_already_bootstrapped_and_exits_zero(
    conn: psycopg.Connection[Any],
    admin_user: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    script = load_script()
    _, email = admin_user
    monkeypatch.setenv("DATABASE_URL", DSN)
    argv = ["--email", email, "--name-ar", "مدير"]

    assert script.main(argv) == 0
    assert "already bootstrapped" not in capsys.readouterr().out
    assert script.main(argv) == 0
    assert "already bootstrapped" in capsys.readouterr().out
