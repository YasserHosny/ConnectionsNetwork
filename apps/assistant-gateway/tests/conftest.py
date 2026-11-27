"""Shared test configuration.

Settings deliberately has no defaults: every value must come from the environment, so that no
secret can hide in the source. Tests therefore supply a complete environment. These are
obviously-fake local values; nothing here is a real credential.
"""

from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# The bearer keys the tests send. Fake, and only their hashes reach the environment.
TEST_APP_KEY = "test-app-key-not-real"
OTHER_APP_KEY = "test-other-app-key-not-real"


def _key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


TEST_ENV: dict[str, str] = {
    "AG_ENV": "local",
    "AG_CONFIG_PATH": str(Path(__file__).parent / "fixtures" / "gateway.yaml"),
    "AG_TEST_CONNECTIONS_KEY_HASH": _key_hash(TEST_APP_KEY),
    "AG_TEST_OTHER_KEY_HASH": _key_hash(OTHER_APP_KEY),
    # A caller that already has its own Postgres (CI's service container) sets TEST_DATABASE_URL;
    # respect it. Otherwise fall back to a local port nothing in this suite connects to yet.
    "AG_DATABASE_URL": os.environ.get(
        "TEST_DATABASE_URL", "postgresql://postgres:postgres@localhost:54329/postgres"
    ),
}


# Applied at import time, before pytest collects: importing a module that builds Settings (or the
# app itself) happens during collection, which is earlier than any fixture runs.
for _key, _value in TEST_ENV.items():
    if _key.startswith("AG_TEST_") or _key == "AG_CONFIG_PATH":
        os.environ[_key] = _value  # the app's own config file: never the caller's
    else:
        os.environ.setdefault(_key, _value)


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Re-assert the environment per test, so one test cannot leak config into the next."""
    for key, value in TEST_ENV.items():
        monkeypatch.setenv(key, value)


_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")


def _is_pytest_handler(handler: logging.Handler) -> bool:
    # pytest adds and removes its own capture handlers around each phase; never restore those.
    return type(handler).__module__.startswith("_pytest")


@pytest.fixture(autouse=True)
def _restore_logging_state() -> Iterator[None]:
    """configure_logging() rewires process-global logging; undo it after every test."""
    root = logging.getLogger()
    root_handlers = list(root.handlers)
    root_level = root.level
    uvicorn_state = {
        name: (list(logging.getLogger(name).handlers), logging.getLogger(name).propagate)
        for name in _UVICORN_LOGGERS
    }
    yield
    for handler in list(root.handlers):
        if handler not in root_handlers:
            root.removeHandler(handler)
    for handler in root_handlers:
        if handler not in root.handlers and not _is_pytest_handler(handler):
            root.addHandler(handler)
    root.setLevel(root_level)
    for name, (handlers, propagate) in uvicorn_state.items():
        logger = logging.getLogger(name)
        logger.handlers[:] = handlers
        logger.propagate = propagate
    logging.captureWarnings(False)


@pytest.fixture
def client() -> TestClient:
    # Imported here, not at the top: importing the app must wait until the environment above is
    # in place.
    from assistant_gateway.main import create_app

    return TestClient(create_app())


@pytest.fixture(autouse=True)
def _reset_rate_limits() -> None:
    """The limiter is process-global and in-memory: start every test with empty budgets."""
    from assistant_gateway.rate_limit import limiter

    limiter.reset()


@pytest.fixture
def auth() -> dict[str, str]:
    """Headers for the `connections` app."""
    return {"Authorization": f"Bearer {TEST_APP_KEY}"}


@pytest.fixture
def other_auth() -> dict[str, str]:
    """Headers for the second app, `other-app`."""
    return {"Authorization": f"Bearer {OTHER_APP_KEY}"}
