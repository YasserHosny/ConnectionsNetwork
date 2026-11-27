"""Startup checks against a real Postgres, and the migrate CLI as the ops runbook runs it.

The shared test database already has its schema migrated, so the "pending" cases use a throwaway
database created for the test (same server, different name; conftest.fresh_database_url).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from assistant_gateway import db, migrate
from assistant_gateway.main import create_app
from assistant_gateway.settings import Settings


def _settings_for(url: str, monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("AG_DATABASE_URL", url)
    return Settings()  # type: ignore[call-arg]


def test_startup_refuses_pending_migration(
    fresh_database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = create_app(_settings_for(fresh_database_url, monkeypatch))
    with pytest.raises(RuntimeError, match="pending migration 0001_ledger"):
        with TestClient(app):
            pass


def test_startup_lists_every_pending_version(
    fresh_database_url: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "0001_ledger.sql").write_text("select 1")
    (tmp_path / "0002_more.sql").write_text("select 1")
    monkeypatch.setattr(migrate, "migrations_dir", lambda: tmp_path)
    app = create_app(_settings_for(fresh_database_url, monkeypatch))
    with pytest.raises(RuntimeError, match=r"pending migration 0001_ledger, 0002_more"):
        with TestClient(app):
            pass


def test_startup_succeeds_once_migrated(
    fresh_database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    with db.connect(fresh_database_url, autocommit=True) as conn:
        migrate.apply(conn)
    app = create_app(_settings_for(fresh_database_url, monkeypatch))
    with TestClient(app) as client:
        assert client.get("/healthz").status_code == 200


def test_startup_succeeds_on_the_migrated_test_database(
    monkeypatch: pytest.MonkeyPatch, database_url: str
) -> None:
    with TestClient(create_app(_settings_for(database_url, monkeypatch))) as client:
        assert client.get("/healthz").status_code == 200


def test_apply_refuses_a_connection_inside_a_transaction(database_url: str) -> None:
    with db.connect(database_url) as conn:  # autocommit off
        with pytest.raises(RuntimeError, match="autocommit"):
            migrate.apply(conn)
        with pytest.raises(RuntimeError, match="autocommit"):
            migrate.pending(conn)


def _run_migrate_cli(url: str) -> subprocess.CompletedProcess[str]:
    # Exactly what the runbook's `docker run -e AG_DATABASE_URL=...` provides: nothing else.
    env = {"PATH": os.environ["PATH"], "AG_DATABASE_URL": url}
    return subprocess.run(
        [sys.executable, "-m", "assistant_gateway.migrate"],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def test_migrate_cli_needs_only_the_database_url(fresh_database_url: str) -> None:
    first = _run_migrate_cli(fresh_database_url)
    assert first.returncode == 0, first.stderr
    assert "applied: 0001_ledger" in first.stdout
    second = _run_migrate_cli(fresh_database_url)
    assert second.returncode == 0, second.stderr
    assert "no pending migrations" in second.stdout
