"""Shared test configuration.

Settings deliberately has no defaults: every value must come from the environment, so that no
secret can hide in the source. Tests therefore supply a complete environment. These are
obviously-fake local values; nothing here is a real credential.
"""

from __future__ import annotations

import os

import pytest

TEST_ENV: dict[str, str] = {
    "API_ENV": "local",
    "API_CORS_ORIGINS": "http://localhost:4200",
    "SUPABASE_URL": "http://localhost:54321",
    "SUPABASE_ANON_KEY": "fake-anon-key-for-tests-only",
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
