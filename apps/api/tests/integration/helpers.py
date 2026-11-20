"""Database fixtures for the integration tests.

Every helper here writes through the connection it is given, which the tests open as the
superuser: the rows are set up OUTSIDE row-level security, so a test then proves what RLS lets a
role see or write, not what the fixture code could.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

import psycopg


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
