"""Startup refusals that need no database, and the migrate CLI's own preconditions."""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace

import pytest

from assistant_gateway import migrate
from assistant_gateway.config import ConfigError
from assistant_gateway.main import create_app
from assistant_gateway.settings import Settings


def test_startup_refuses_invalid_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text("apps: {}\n")
    monkeypatch.setenv("AG_CONFIG_PATH", str(bad))
    with pytest.raises(ConfigError, match="Invalid configuration"):
        create_app(Settings())  # type: ignore[call-arg]


def test_startup_refuses_a_missing_key_hash(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AG_TEST_CONNECTIONS_KEY_HASH")
    with pytest.raises(ConfigError, match="AG_TEST_CONNECTIONS_KEY_HASH is not set"):
        create_app(Settings())  # type: ignore[call-arg]


def test_startup_refuses_a_missing_config_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AG_CONFIG_PATH", str(tmp_path / "absent.yaml"))
    with pytest.raises(ConfigError, match="Cannot read configuration file"):
        create_app(Settings())  # type: ignore[call-arg]


@pytest.mark.parametrize("call", [migrate.apply, migrate.pending])
def test_migrations_refuse_a_connection_that_is_not_autocommit(call: Callable[..., object]) -> None:
    not_autocommit = SimpleNamespace(autocommit=False)
    with pytest.raises(RuntimeError, match="autocommit"):
        call(not_autocommit)


def test_migrate_cli_without_a_database_url_says_so() -> None:
    env = {"PATH": os.environ["PATH"]}
    result = subprocess.run(
        [sys.executable, "-m", "assistant_gateway.migrate"],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode != 0
    assert "AG_DATABASE_URL" in result.stderr
    assert "Traceback" not in result.stderr
