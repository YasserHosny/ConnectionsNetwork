"""Shared test configuration.

Settings deliberately has no defaults: every value must come from the environment, so that no
secret can hide in the source. Tests therefore supply a complete environment. These are
obviously-fake local values; nothing here is a real credential.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterator

import pytest

TEST_ENV: dict[str, str] = {
    "API_ENV": "local",
    "API_CORS_ORIGINS": "http://localhost:4200",
    "SUPABASE_URL": "http://localhost:54321",
    "SUPABASE_ANON_KEY": "fake-anon-key-for-tests-only",
    "SUPABASE_JWT_SECRET": "test-secret-value-not-used-anywhere-real",
    "SUPABASE_JWT_AUDIENCE": "authenticated",
    "SUPABASE_JWT_ISSUER": "http://localhost:54321/auth/v1",
    # A caller that already has its own Postgres (scripts/test-db.sh, CI's service container) sets
    # TEST_DATABASE_URL; respect it so get_settings()-based code reaches the database the
    # migrations were applied to. Otherwise fall back to the port scripts/test-db.sh uses.
    "DATABASE_URL": os.environ.get(
        "TEST_DATABASE_URL", "postgresql://postgres:postgres@localhost:54329/postgres"
    ),
    "WEB_PUBLIC_URL": "http://localhost:4200",
}


# Applied at import time, before pytest collects: importing a module that builds Settings (or the
# app itself) happens during collection, which is earlier than any fixture runs.
for _key, _value in TEST_ENV.items():
    os.environ.setdefault(_key, _value)


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Re-assert the environment per test, so one test cannot leak config into the next."""
    for key, value in TEST_ENV.items():
        monkeypatch.setenv(key, value)


@pytest.fixture(autouse=True)
def _reset_rate_limits() -> None:
    """The limiter is process-global, in-memory: start every test with empty budgets."""
    # Imported here, not at the top: importing the app's modules must wait until the environment
    # above is in place.
    from connections_api.shared.rate_limit import limiter

    limiter.reset()


_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")


def _is_pytest_handler(handler: logging.Handler) -> bool:
    # pytest adds and removes its own capture handlers around each phase; never restore those.
    return type(handler).__module__.startswith("_pytest")


@pytest.fixture(autouse=True)
def _restore_logging_state() -> Iterator[None]:
    """configure_logging() rewires process-global logging; undo it after every test.

    Without this, a test that calls it leaves the root handler bound to that test's (later
    closed) captured stream, and every following test that logs emits "I/O operation on closed
    file" errors, making the suite order-dependent.
    """
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
