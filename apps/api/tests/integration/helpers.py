"""Database fixtures for the integration tests.

Every helper here writes through the connection it is given, which the tests open as the
superuser: the rows are set up OUTSIDE row-level security, so a test then proves what RLS lets a
role see or write, not what the fixture code could.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

import psycopg
from jose import jwt

JWT_SECRET = "test-secret-value-not-used-anywhere-real"


@dataclass(frozen=True)
class NetworkFixture:
    network_id: UUID
    admin_person_id: UUID
    # The claims the custom access token hook issues to this network's admin after TOTP MFA.
    admin_claims: dict[str, str]


def make_network(conn: psycopg.Connection[Any], *, name: str = "Test network") -> NetworkFixture:
    """A network, its admin's auth.users row, the admin's person and their active admin member."""
    network_id = uuid4()
    user_id = uuid4()
    with conn.transaction():
        conn.execute("insert into network (id, name) values (%s, %s)", (network_id, name))
        conn.execute(
            "insert into auth.users (id, email) values (%s, %s)",
            (user_id, f"admin-{user_id}@example.test"),
        )
        admin_person_id = make_person(conn, network_id, name_latin="Network Admin")
        conn.execute(
            "insert into member (network_id, user_id, person_id, role, status)"
            " values (%s, %s, %s, 'admin', 'active')",
            (network_id, user_id, admin_person_id),
        )
    return NetworkFixture(
        network_id=network_id,
        admin_person_id=admin_person_id,
        admin_claims={
            "sub": str(user_id),
            "network_id": str(network_id),
            "member_role": "admin",
            "person_id": str(admin_person_id),
            "role": "authenticated",
            "aal": "aal2",
        },
    )


def token_for(claims: dict[str, str]) -> str:
    """A Supabase-shaped access token (HS256, the test secret) carrying `claims`."""
    return jwt.encode(
        {
            **claims,
            "aud": "authenticated",
            "iss": "http://localhost:54321/auth/v1",
            "exp": int(time.time()) + 3600,
        },
        JWT_SECRET,
        "HS256",
    )


def make_member(conn: psycopg.Connection[Any], network: NetworkFixture) -> dict[str, str]:
    """An active `member` account in the network, with their own person. Returns their claims.

    The claims are what the access token hook stamps for a member (spec 7.1): no `aal2`, since
    members are not admins and are not required to complete TOTP MFA.
    """
    user_id = uuid4()
    with conn.transaction():
        conn.execute(
            "insert into auth.users (id, email) values (%s, %s)",
            (user_id, f"member-{user_id}@example.test"),
        )
        person_id = make_person(conn, network.network_id, name_latin="Network Member")
        conn.execute(
            "insert into member (network_id, user_id, person_id, role, status)"
            " values (%s, %s, %s, 'member', 'active')",
            (network.network_id, user_id, person_id),
        )
    return {
        "sub": str(user_id),
        "network_id": str(network.network_id),
        "member_role": "member",
        "person_id": str(person_id),
        "role": "authenticated",
        "aal": "aal1",
    }


def make_person(
    conn: psycopg.Connection[Any],
    network_id: UUID,
    *,
    name_ar: str | None = None,
    name_latin: str | None = "Test Person",
) -> UUID:
    row = conn.execute(
        "insert into person (network_id, name_ar, name_latin) values (%s, %s, %s) returning id",
        (network_id, name_ar, name_latin),
    ).fetchone()
    assert row is not None
    return row[0]


def drop_network(conn: psycopg.Connection[Any], network: NetworkFixture) -> None:
    """Delete the network (every table cascades from it) and its members' auth.users rows."""
    with conn.transaction():
        user_ids = [
            row[0]
            for row in conn.execute(
                "select user_id from member where network_id = %s", (network.network_id,)
            )
        ]
        conn.execute("delete from network where id = %s", (network.network_id,))
        conn.execute("delete from auth.users where id = any(%s)", (user_ids,))
