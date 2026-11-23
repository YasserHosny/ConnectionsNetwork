"""Member visibility (spec 7.1, 7.2): migration 20261119000005_member_visibility.sql.

A member sees the people they created and their own person, only the contact values they
entered (plus every value on their own claimed profile) and only the connections they created.
Fixtures are written as the superuser (outside RLS); every assertion about access runs inside
``db.user_tx`` with member claims, as a request would.

Skipped unless TEST_DATABASE_URL is set. CI always sets it, so there an unreachable or
unprepared database fails these tests rather than hollowing out the suite.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import psycopg
import pytest
from integration.helpers import NetworkFixture, drop_network, make_member, make_network
from psycopg import errors

from connections_api import db

pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL is not set"
)

DSN = os.environ.get("TEST_DATABASE_URL", "")


@pytest.fixture
def conn() -> Iterator[psycopg.Connection[Any]]:
    """The superuser connection the fixtures are written through."""
    with db.connect(DSN, autocommit=True) as connection:
        yield connection


@pytest.fixture
def network(conn: psycopg.Connection[Any]) -> Iterator[NetworkFixture]:
    fixture = make_network(conn)
    yield fixture
    drop_network(conn, fixture)


@pytest.fixture
def two_networks(conn: psycopg.Connection[Any]) -> Iterator[tuple[NetworkFixture, NetworkFixture]]:
    a, b = make_network(conn), make_network(conn)
    yield a, b
    drop_network(conn, a)
    drop_network(conn, b)


def _pid(claims: dict[str, str]) -> UUID:
    return UUID(claims["person_id"])


def _person(
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    name: str,
    *,
    created_by: UUID | None = None,
) -> UUID:
    row = conn.execute(
        "insert into person (network_id, name_latin, created_by_person_id)"
        " values (%s, %s, %s) returning id",
        (network.network_id, name, created_by),
    ).fetchone()
    assert row is not None
    return row[0]


def _value(
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    person: UUID,
    kind: str,
    value: str,
    *,
    added_by: UUID | None,
) -> UUID:
    row = conn.execute(
        "insert into contact_value (network_id, person_id, kind, value, added_by_person_id)"
        " values (%s, %s, %s, %s, %s) returning id",
        (network.network_id, person, kind, value, added_by),
    ).fetchone()
    assert row is not None
    return row[0]


def _ids(claims: dict[str, str], table: str, column: str = "id") -> set[UUID]:
    with db.user_tx(claims, dsn=DSN) as tx:
        return {row[0] for row in tx.execute(f"select {column} from {table}")}  # noqa: S608


def test_member_sees_only_own_contact_values(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    x = make_member(conn, network)
    y = make_member(conn, network)
    # One person who both X and Y hold details for (what a merge leaves behind).
    shared = _person(conn, network, "Shared", created_by=_pid(x))
    phone = _value(conn, network, shared, "phone", "010 1234 5678", added_by=_pid(x))
    _value(conn, network, shared, "email", "shared@example.test", added_by=_pid(y))

    assert _ids(x, "contact_value") == {phone}


def test_member_cannot_see_others_people(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    x = make_member(conn, network)
    y = make_member(conn, network)
    mine = _person(conn, network, "Mine", created_by=_pid(x))
    _person(conn, network, "Theirs", created_by=_pid(y))
    _person(conn, network, "Orphan", created_by=None)

    assert _ids(x, "person") == {_pid(x), mine}


def test_member_sees_all_values_on_own_profile(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    x = make_member(conn, network)
    y = make_member(conn, network)
    phone = _value(conn, network, _pid(x), "phone", "010 1234 5678", added_by=_pid(x))
    email = _value(conn, network, _pid(x), "email", "x@example.test", added_by=_pid(y))
    by_admin = _value(
        conn, network, _pid(x), "whatsapp", "010 9999 0000", added_by=network.admin_person_id
    )
    unknown = _value(conn, network, _pid(x), "phone", "010 8888 0000", added_by=None)

    assert _ids(x, "contact_value") == {phone, email, by_admin, unknown}
    # Y entered one value, on X's profile: that is the only one Y sees.
    assert _ids(y, "contact_value") == {email}


def test_member_cannot_escalate_added_by(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    x = make_member(conn, network)
    y = make_member(conn, network)
    target = _person(conn, network, "Target", created_by=_pid(x))

    with pytest.raises(errors.InsufficientPrivilege, match="row-level security"):
        with db.user_tx(x, dsn=DSN) as tx:
            tx.execute(
                "insert into contact_value (network_id, person_id, kind, value, added_by_person_id)"
                " values (%s, %s, 'phone', '010 1234 5678', %s)",
                (network.network_id, target, _pid(y)),
            )

    # Nor can X hand an existing value of theirs over to Y by updating it.
    mine = _value(conn, network, target, "phone", "010 5555 0000", added_by=_pid(x))
    with pytest.raises(errors.InsufficientPrivilege, match="row-level security"):
        with db.user_tx(x, dsn=DSN) as tx:
            tx.execute(
                "update contact_value set added_by_person_id = %s where id = %s", (_pid(y), mine)
            )


def test_member_writes_own_contact_values_only(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    x = make_member(conn, network)
    y = make_member(conn, network)
    target = _person(conn, network, "Target", created_by=_pid(x))
    ys = _value(conn, network, target, "email", "y@example.test", added_by=_pid(y))

    with db.user_tx(x, dsn=DSN) as tx:
        row = tx.execute(
            "insert into contact_value (network_id, person_id, kind, value, added_by_person_id)"
            " values (%s, %s, 'phone', '010 1234 5678', %s) returning id",
            (network.network_id, target, _pid(x)),
        ).fetchone()
        assert row is not None
        tx.execute("update contact_value set value = '010 2222 3333' where id = %s", (row[0],))
        # Y's value is invisible to X, so X's update and delete reach zero rows.
        assert tx.execute("update contact_value set value = 'z' where id = %s", (ys,)).rowcount == 0
        assert tx.execute("delete from contact_value where id = %s", (ys,)).rowcount == 0
        assert tx.execute("delete from contact_value where id = %s", (row[0],)).rowcount == 1

    assert conn.execute("select count(*) from contact_value where id = %s", (ys,)).fetchone() == (
        1,
    )


def test_claimed_profile_owner_edits_and_deletes_any_value_on_it(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    x = make_member(conn, network)
    y = make_member(conn, network)
    theirs = _value(conn, network, _pid(x), "email", "x@example.test", added_by=_pid(y))

    with db.user_tx(x, dsn=DSN) as tx:
        # Spec 7.2: the owner may edit or delete anything stored about them. The row keeps its
        # provenance (Y), which the owner's policy allows because the row is on their profile.
        assert (
            tx.execute(
                "update contact_value set value = 'new@example.test' where id = %s", (theirs,)
            ).rowcount
            == 1
        )
        assert tx.execute("delete from contact_value where id = %s", (theirs,)).rowcount == 1


def test_member_person_writes(conn: psycopg.Connection[Any], network: NetworkFixture) -> None:
    x = make_member(conn, network)
    y = make_member(conn, network)
    theirs = _person(conn, network, "Theirs", created_by=_pid(y))
    mine = _person(conn, network, "Mine", created_by=_pid(x))

    with db.user_tx(x, dsn=DSN) as tx:
        # Insert a person X created.
        row = tx.execute(
            "insert into person (network_id, name_latin, created_by_person_id)"
            " values (%s, 'Added', %s) returning id",
            (network.network_id, _pid(x)),
        ).fetchone()
        assert row is not None
        # Update own profile and a person X added; Y's person is unreachable.
        assert (
            tx.execute("update person set city = 'Cairo' where id = %s", (_pid(x),)).rowcount == 1
        )
        assert tx.execute("update person set city = 'Giza' where id = %s", (mine,)).rowcount == 1
        assert tx.execute("update person set city = 'Luxor' where id = %s", (theirs,)).rowcount == 0

    # A person cannot be created in someone else's name, or without a creator.
    for creator in (_pid(y), None):
        with pytest.raises(errors.InsufficientPrivilege, match="row-level security"):
            with db.user_tx(x, dsn=DSN) as tx:
                tx.execute(
                    "insert into person (network_id, name_latin, created_by_person_id)"
                    " values (%s, 'Forged', %s)",
                    (network.network_id, creator),
                )

    # A person X added cannot be re-attributed to Y by updating it.
    with pytest.raises(errors.InsufficientPrivilege, match="row-level security"):
        with db.user_tx(x, dsn=DSN) as tx:
            tx.execute("update person set created_by_person_id = %s where id = %s", (_pid(y), mine))


def test_member_cannot_delete_people(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    # Deleting a person is admin-only until the product decides otherwise (not in the policy set).
    x = make_member(conn, network)
    mine = _person(conn, network, "Mine", created_by=_pid(x))

    with db.user_tx(x, dsn=DSN) as tx:
        assert tx.execute("delete from person where id = %s", (mine,)).rowcount == 0
    assert conn.execute("select count(*) from person where id = %s", (mine,)).fetchone() == (1,)


def test_member_sees_only_connections_they_created(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    x = make_member(conn, network)
    y = make_member(conn, network)
    p = _person(conn, network, "P", created_by=_pid(x))
    q = _person(conn, network, "Q", created_by=_pid(x))
    r = _person(conn, network, "R", created_by=_pid(y))

    def edge(a: UUID, b: UUID, by: UUID) -> UUID:
        lo, hi = sorted([a, b])
        row = conn.execute(
            "insert into connection"
            " (network_id, person_a, person_b, strength, created_by_person_id)"
            " values (%s, %s, %s, 'normal', %s) returning id",
            (network.network_id, lo, hi, by),
        ).fetchone()
        assert row is not None
        return row[0]

    mine = edge(p, q, _pid(x))
    edge(q, r, _pid(y))
    edge(p, r, network.admin_person_id)

    assert _ids(x, "connection") == {mine}

    lo, hi = sorted([_pid(x), p])
    insert = (
        "insert into connection (network_id, person_a, person_b, strength, created_by_person_id)"
        " values (%s, %s, %s, 'weak', %s)"
    )
    with db.user_tx(x, dsn=DSN) as tx:
        tx.execute(insert, (network.network_id, lo, hi, _pid(x)))
    with pytest.raises(errors.InsufficientPrivilege, match="row-level security"):
        with db.user_tx(x, dsn=DSN) as tx:
            tx.execute(insert, (network.network_id, *sorted([_pid(x), q]), _pid(y)))


def test_child_rows_follow_person_visibility(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    x = make_member(conn, network)
    y = make_member(conn, network)
    mine = _person(conn, network, "Mine", created_by=_pid(x))
    theirs = _person(conn, network, "Theirs", created_by=_pid(y))
    nid = network.network_id
    skill = conn.execute(
        "insert into tag (network_id, kind, category, label)"
        " values (%s, 'skill', 'business', 'Marketing') returning id",
        (nid,),
    ).fetchone()
    industry = conn.execute(
        "insert into tag (network_id, kind, label) values (%s, 'industry', 'Banking') returning id",
        (nid,),
    ).fetchone()
    assert skill is not None
    assert industry is not None
    for person in (mine, theirs):
        conn.execute(
            "insert into person_skill (network_id, person_id, tag_id) values (%s, %s, %s)",
            (nid, person, skill[0]),
        )
        conn.execute(
            "insert into person_industry (network_id, person_id, tag_id) values (%s, %s, %s)",
            (nid, person, industry[0]),
        )
        conn.execute(
            "insert into social_link (network_id, person_id, kind, url)"
            " values (%s, %s, 'github', 'https://github.com/x')",
            (nid, person),
        )

    for table in ("person_skill", "person_industry", "social_link"):
        assert _ids(x, table, "person_id") == {mine}, table

    with db.user_tx(x, dsn=DSN) as tx:
        # Writes follow the same rule: a link on X's person works, one on Y's person is refused.
        tx.execute(
            "insert into social_link (network_id, person_id, kind, url)"
            " values (%s, %s, 'x', 'https://x.com/mine')",
            (nid, mine),
        )
        assert tx.execute("delete from person_skill where person_id = %s", (theirs,)).rowcount == 0
    with pytest.raises(errors.InsufficientPrivilege, match="row-level security"):
        with db.user_tx(x, dsn=DSN) as tx:
            tx.execute(
                "insert into social_link (network_id, person_id, kind, url)"
                " values (%s, %s, 'x', 'https://x.com/theirs')",
                (nid, theirs),
            )


def test_member_tag_select_and_insert_only(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    x = make_member(conn, network)
    existing = conn.execute(
        "insert into tag (network_id, kind, category, label)"
        " values (%s, 'skill', 'business', 'Marketing') returning id",
        (network.network_id,),
    ).fetchone()
    assert existing is not None

    with db.user_tx(x, dsn=DSN) as tx:
        row = tx.execute(
            "insert into tag (network_id, kind, label) values (%s, 'industry', 'Banking')"
            " returning id",
            (network.network_id,),
        ).fetchone()
        assert row is not None
        visible = {r[0] for r in tx.execute("select id from tag")}
        assert visible == {existing[0], row[0]}
        # Renaming, merging and deleting tags are admin tools.
        assert tx.execute("update tag set label = 'Hacked'").rowcount == 0
        assert tx.execute("delete from tag").rowcount == 0


def test_member_cannot_reach_admin_only_tables(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    x = make_member(conn, network)
    conn.execute(
        "insert into contributor_link (network_id, person_id, token_hash)"
        " values (%s, %s, sha256('t'::bytea))",
        (network.network_id, network.admin_person_id),
    )
    a, b = sorted([network.admin_person_id, _pid(x)])
    conn.execute(
        "insert into duplicate_dismissal (network_id, person_a, person_b) values (%s, %s, %s)",
        (network.network_id, a, b),
    )

    for table in ("contributor_link", "duplicate_dismissal", "member", "network"):
        assert _ids(x, table, "network_id" if table != "network" else "id") == set(), table


def test_members_are_isolated_across_networks(
    conn: psycopg.Connection[Any], two_networks: tuple[NetworkFixture, NetworkFixture]
) -> None:
    a, b = two_networks
    x = make_member(conn, a)
    _person(conn, b, "In B")
    # Claims are signed in reality; this stands in for a member of A reaching into B.
    forged = {**x, "network_id": str(b.network_id)}

    assert _ids(forged, "person") == set()
    with pytest.raises(errors.InsufficientPrivilege, match="row-level security"):
        with db.user_tx(x, dsn=DSN) as tx:
            tx.execute(
                "insert into person (network_id, name_latin, created_by_person_id)"
                " values (%s, 'Planted', %s)",
                (b.network_id, _pid(x)),
            )


def test_member_policies_ignore_non_member_roles(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    """The same person_id under a role claim that is neither admin nor member sees nothing."""
    x = make_member(conn, network)
    _value(conn, network, _pid(x), "phone", "010 1234 5678", added_by=_pid(x))
    for role in ("viewer", None):
        claims = {k: v for k, v in x.items() if k != "member_role"}
        if role:
            claims["member_role"] = role
        assert _ids(claims, "person") == set()
        assert _ids(claims, "contact_value") == set()
