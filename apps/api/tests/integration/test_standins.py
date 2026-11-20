"""The Supabase stand-ins (supabase/tests/standins.sql) are in place in the test database.

Skipped unless TEST_DATABASE_URL is set. CI always sets it, so there a missing or unprepared
database fails this test rather than letting the database-backed suite hollow out.
"""

from __future__ import annotations

import os

import pytest

from connections_api import db

pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL is not set"
)


def test_supabase_roles_and_auth_users_exist() -> None:
    with db.connect(os.environ["TEST_DATABASE_URL"]) as conn:
        roles = {
            row[0]
            for row in conn.execute(
                "select rolname from pg_roles"
                " where rolname in ('anon', 'authenticated', 'service_role', 'supabase_auth_admin')"
            )
        }
        auth_users = conn.execute("select to_regclass('auth.users')").fetchone()

    assert roles == {"anon", "authenticated", "service_role", "supabase_auth_admin"}
    assert auth_users is not None
    assert auth_users[0] == "auth.users"
