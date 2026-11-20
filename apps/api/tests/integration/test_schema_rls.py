"""Core schema, network-scoped RLS and the custom access token hook.

Migrations 20261119000002_core_schema.sql, 20261119000003_rls.sql and
20261119000004_auth_hook.sql. Fixtures are written as the superuser (outside RLS); every
assertion about access runs inside ``db.user_tx``, as the role a request would use.

Skipped unless TEST_DATABASE_URL is set. CI always sets it, so there an unreachable or
unprepared database fails these tests rather than hollowing out the suite.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Iterator
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
from integration.helpers import NetworkFixture, drop_network, make_network, make_person
from psycopg import errors, sql

from connections_api import db

pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL is not set"
)

DSN = os.environ.get("TEST_DATABASE_URL", "")

MakeNetwork = Callable[[], NetworkFixture]


@pytest.fixture
def conn() -> Iterator[psycopg.Connection[Any]]:
    """The superuser connection the fixtures are written through."""
    with db.connect(DSN, autocommit=True) as connection:
        yield connection


@pytest.fixture
def networks(conn: psycopg.Connection[Any]) -> Iterator[MakeNetwork]:
    """Factory for fresh networks; each one is deleted (with everything in it) afterwards."""
    created: list[NetworkFixture] = []

    def make() -> NetworkFixture:
        network = make_network(conn)
        created.append(network)
        return network

    yield make
    for network in created:
        drop_network(conn, network)


def _public_tables(conn: psycopg.Connection[Any]) -> list[str]:
    return [
        row[0]
        for row in conn.execute(
            "select tablename from pg_tables where schemaname = 'public' order by tablename"
        )
    ]


def _seed_every_table(conn: psycopg.Connection[Any], network: NetworkFixture) -> None:
    """Give every table in the network at least one row, so 'sees nothing' means something."""
    nid = network.network_id
    other = make_person(conn, nid, name_latin="Other Person")
    a, b = sorted([network.admin_person_id, other])
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
    conn.execute(
        "insert into person_skill (network_id, person_id, tag_id, level)"
        " values (%s, %s, %s, 'expert')",
        (nid, other, skill[0]),
    )
    conn.execute(
        "insert into person_industry (network_id, person_id, tag_id) values (%s, %s, %s)",
        (nid, other, industry[0]),
    )
    conn.execute(
        "insert into social_link (network_id, person_id, kind, url)"
        " values (%s, %s, 'linkedin', 'https://www.linkedin.com/in/other/')",
        (nid, other),
    )
    conn.execute(
        "insert into contact_value (network_id, person_id, kind, value, added_by_person_id)"
        " values (%s, %s, 'phone', '010 1234 5678', %s)",
        (nid, other, network.admin_person_id),
    )
    conn.execute(
        "insert into connection (network_id, person_a, person_b, strength, created_by_person_id)"
        " values (%s, %s, %s, 'strong', %s)",
        (nid, a, b, network.admin_person_id),
    )
    conn.execute(
        "insert into contributor_link (network_id, person_id, token_hash)"
        " values (%s, %s, sha256(%s::bytea))",
        (nid, network.admin_person_id, uuid4().bytes),
    )
    conn.execute(
        "insert into duplicate_dismissal (network_id, person_a, person_b) values (%s, %s, %s)",
        (nid, a, b),
    )
    conn.execute(
        "insert into idempotency_key (network_id, scope, key, person_id)"
        " values (%s, 'admin', %s, %s)",
        (nid, str(uuid4()), other),
    )


def _count(tx: psycopg.Connection[Any], table: str) -> int:
    row = tx.execute(sql.SQL("select count(*) from {}").format(sql.Identifier(table))).fetchone()
    assert row is not None
    return row[0]


def test_every_table_is_network_scoped_with_forced_rls(conn: psycopg.Connection[Any]) -> None:
    rows = conn.execute(
        "select c.relname, c.relrowsecurity, c.relforcerowsecurity,"
        "       exists (select 1 from pg_attribute a where a.attrelid = c.oid"
        "               and a.attname = 'network_id' and not a.attisdropped and a.attnotnull)"
        " from pg_class c join pg_namespace n on n.oid = c.relnamespace"
        " where n.nspname = 'public' and c.relkind = 'r' order by c.relname"
    ).fetchall()

    assert {r[0] for r in rows} == {
        "network",
        "member",
        "person",
        "tag",
        "person_skill",
        "person_industry",
        "social_link",
        "contact_value",
        "connection",
        "contributor_link",
        "duplicate_dismissal",
        "idempotency_key",
    }
    for name, enabled, forced, has_network_id in rows:
        assert enabled and forced, f"{name}: RLS must be ENABLEd and FORCEd"
        assert has_network_id or name == "network", f"{name}: needs network_id not null"


def test_every_policy_checks_what_it_writes(conn: psycopg.Connection[Any]) -> None:
    """A policy without WITH CHECK lets a role write rows its USING clause would hide.

    For FOR ALL and UPDATE, Postgres reuses USING as the check when WITH CHECK is omitted, so the
    omission is silent; for INSERT a missing check is an unconditional allow. Every policy that
    can write therefore states its WITH CHECK explicitly, and every table has a policy at all
    (a table with RLS forced and no policy is merely closed, which is almost never intended).
    """
    policies = conn.execute(
        "select tablename, policyname, cmd, with_check is not null"
        " from pg_policies where schemaname = 'public'"
    ).fetchall()

    assert set(_public_tables(conn)) <= {row[0] for row in policies}, (
        "every public table needs at least one policy"
    )
    unchecked = [
        f"{table}.{name} ({cmd})"
        for table, name, cmd, has_check in policies
        if cmd in {"ALL", "INSERT", "UPDATE"} and not has_check
    ]
    assert unchecked == []


# Functions a request role may execute. Everything else in `public` (the token hook, the
# contributor-link functions) is refused to them; pg_trgm's own functions are not checked.
_PURE_FUNCTIONS = {
    "normalize_text", "normalize_phone", "normalize_email", "normalize_url",
    "current_network_id", "current_member_role", "current_person_id",
}  # fmt: skip
_EXECUTABLE_BY = {
    "anon": _PURE_FUNCTIONS,
    "authenticated": _PURE_FUNCTIONS | {"upsert_tag", "merge_persons", "suggest_tags"},
}


def test_request_roles_hold_only_the_privileges_they_need(conn: psycopg.Connection[Any]) -> None:
    """Hosted default privileges are taken back (the stand-ins emulate them).

    TRUNCATE ignores RLS, so `authenticated` holding it would let any signed-in session empty a
    table; REFERENCES and TRIGGER are not needed either. `anon` holds nothing on any table.
    """
    for table in _public_tables(conn):
        held = conn.execute(
            "select p, has_table_privilege('authenticated', format('public.%%I', %s::text), p)"
            " from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE',"
            "                   'TRUNCATE', 'REFERENCES', 'TRIGGER']) p",
            (table,),
        ).fetchall()
        assert {p for p, has in held if has} == {"SELECT", "INSERT", "UPDATE", "DELETE"}, table
        anon = conn.execute(
            "select bool_or(has_table_privilege('anon', format('public.%%I', %s::text), p))"
            " from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE',"
            "                   'TRUNCATE', 'REFERENCES', 'TRIGGER']) p",
            (table,),
        ).fetchone()
        assert anon == (False,), table

    functions = conn.execute(
        "select p.proname, has_function_privilege('anon', p.oid, 'execute'),"
        "       has_function_privilege('authenticated', p.oid, 'execute')"
        " from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'"
        " where not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass"
        "                   and d.objid = p.oid and d.deptype = 'e')"
    ).fetchall()
    assert {name for name, anon, _ in functions if anon} == _EXECUTABLE_BY["anon"]
    assert {name for name, _, auth in functions if auth} == _EXECUTABLE_BY["authenticated"]


def test_default_privileges_grant_nothing_to_request_roles(conn: psycopg.Connection[Any]) -> None:
    """A table or function a LATER migration adds must not inherit the hosted grants either."""
    rows = conn.execute(
        "select d.defaclobjtype, a.grantee::regrole::text"
        " from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace"
        " cross join lateral aclexplode(d.defaclacl) a"
        " where n.nspname = 'public' and a.grantee in ('anon'::regrole, 'authenticated'::regrole)"
    ).fetchall()
    assert rows == []


def test_admin_sees_own_network_only(conn: psycopg.Connection[Any], networks: MakeNetwork) -> None:
    a = networks()
    b = networks()
    a_other = make_person(conn, a.network_id, name_latin="In A")
    make_person(conn, b.network_id, name_latin="In B")

    with db.user_tx(a.admin_claims, dsn=DSN) as tx:
        ids = {row[0] for row in tx.execute("select id from person")}
        visible_networks = {row[0] for row in tx.execute("select id from network")}

    assert ids == {a.admin_person_id, a_other}
    assert visible_networks == {a.network_id}


def test_no_claims_sees_nothing(conn: psycopg.Connection[Any], networks: MakeNetwork) -> None:
    network = networks()
    _seed_every_table(conn, network)
    tables = _public_tables(conn)

    for table in tables:
        # The admin does see the seeded row, so the zeros below are RLS, not empty tables.
        with db.user_tx(network.admin_claims, dsn=DSN) as tx:
            assert _count(tx, table) >= 1, table

        # No claims at all is the anon role, which holds no privilege on any table.
        with pytest.raises(errors.InsufficientPrivilege):
            with db.user_tx({}, dsn=DSN) as tx:
                assert tx.execute("select current_user").fetchone() == ("anon",)
                _count(tx, table)

        # Signed in but without a network claim (no active member): every policy denies.
        with db.user_tx({"sub": str(uuid4()), "role": "authenticated"}, dsn=DSN) as tx:
            assert _count(tx, table) == 0, table


@pytest.mark.parametrize("aal", ["aal1", None], ids=["aal1", "no aal"])
def test_admin_without_mfa_sees_nothing(
    conn: psycopg.Connection[Any], networks: MakeNetwork, aal: str | None
) -> None:
    """The admin policies require aal2 in the claims, not only the API (spec 10).

    Hosted Supabase serves `public` to anyone holding the anon key plus a session, so a
    password-only (aal1) admin session must not reach a single row by going around the API.
    """
    network = networks()
    _seed_every_table(conn, network)
    claims = {k: v for k, v in network.admin_claims.items() if k != "aal"}
    if aal is not None:
        claims["aal"] = aal

    for table in _public_tables(conn):
        with db.user_tx(claims, dsn=DSN) as tx:
            assert _count(tx, table) == 0, table
            assert tx.execute("select public.current_member_role()").fetchone() == (None,)

    with pytest.raises(errors.InsufficientPrivilege, match="row-level security"):
        with db.user_tx(claims, dsn=DSN) as tx:
            tx.execute(
                "insert into person (network_id, name_latin) values (%s, 'Planted')",
                (network.network_id,),
            )


def test_member_role_is_unaffected_by_aal(networks: MakeNetwork) -> None:
    network = networks()
    member_claims = {**network.admin_claims, "member_role": "member", "aal": "aal1"}

    with db.user_tx(member_claims, dsn=DSN) as tx:
        assert tx.execute("select public.current_member_role()").fetchone() == ("member",)
    with db.user_tx(network.admin_claims, dsn=DSN) as tx:
        assert tx.execute("select public.current_member_role()").fetchone() == ("admin",)


def test_cross_network_insert_rejected(networks: MakeNetwork) -> None:
    a = networks()
    b = networks()

    with pytest.raises(errors.InsufficientPrivilege, match="row-level security"):
        with db.user_tx(a.admin_claims, dsn=DSN) as tx:
            tx.execute(
                "insert into person (network_id, name_latin) values (%s, 'Planted')",
                (b.network_id,),
            )


def test_member_role_claim_is_not_admin(
    conn: psycopg.Connection[Any], networks: MakeNetwork
) -> None:
    network = networks()
    make_person(conn, network.network_id, name_latin="Someone Else")
    member_claims = {**network.admin_claims, "member_role": "member"}

    # Member visibility itself is covered in test_member_visibility.py. Here: the admin policy
    # does not match, so the same person_id sees only its own person, not the network's.
    with db.user_tx(member_claims, dsn=DSN) as tx:
        assert _count(tx, "person") == 1
        assert _count(tx, "member") == 0
        assert _count(tx, "network") == 0


def _pair(conn: psycopg.Connection[Any], network: NetworkFixture) -> tuple[UUID, UUID]:
    other = make_person(conn, network.network_id, name_latin="Friend")
    a, b = sorted([network.admin_person_id, other])
    return a, b


# Each statement is written by admin A, in network A, but points at an object of network B.
# Foreign-key checks bypass RLS, so only network-scoped (composite) foreign keys reject these.
# Placeholders: {a} A's network, {pa} A's admin person, {pb} B's admin person, {qb} a B person
# with no account, {tb} a tag in B, {lb} a contributor link in B, {u} a fresh auth.users id.
CROSS_NETWORK_REFERENCES = {
    "connection to B's person": (
        "insert into connection (network_id, person_a, person_b, strength)"
        " values ({a}, least({pa}, {pb}), greatest({pa}, {pb}), 'strong')"
    ),
    "person_skill with B's tag": (
        "insert into person_skill (network_id, person_id, tag_id) values ({a}, {pa}, {tb})"
    ),
    "person_industry for B's person": (
        "insert into person_industry (network_id, person_id, tag_id) values ({a}, {pb}, {tb})"
    ),
    "social_link for B's person": (
        "insert into social_link (network_id, person_id, kind, url)"
        " values ({a}, {pb}, 'github', 'https://github.com/x')"
    ),
    "contact_value added by B's person": (
        "insert into contact_value (network_id, person_id, kind, value, added_by_person_id)"
        " values ({a}, {pa}, 'email', 'x@example.test', {pb})"
    ),
    "person created by B's person": (
        "insert into person (network_id, name_latin, created_by_person_id) values ({a}, 'X', {pb})"
    ),
    "person from B's contributor link": (
        "insert into person (network_id, name_latin, contributor_link_id) values ({a}, 'X', {lb})"
    ),
    "tag aliasing B's tag": (
        "insert into tag (network_id, kind, category, label, alias_of_tag_id)"
        " values ({a}, 'skill', 'business', 'mktg', {tb})"
    ),
    "contributor_link for B's person": (
        "insert into contributor_link (network_id, person_id, token_hash)"
        " values ({a}, {pb}, sha256('x'::bytea))"
    ),
    "member for B's person": (
        "insert into member (network_id, user_id, person_id, role)"
        " values ({a}, {u}, {qb}, 'member')"
    ),
    "duplicate_dismissal with B's person": (
        "insert into duplicate_dismissal (network_id, person_a, person_b)"
        " values ({a}, least({pa}, {pb}), greatest({pa}, {pb}))"
    ),
}


@pytest.mark.parametrize(
    "statement", CROSS_NETWORK_REFERENCES.values(), ids=list(CROSS_NETWORK_REFERENCES)
)
def test_cross_network_reference_rejected(
    conn: psycopg.Connection[Any], networks: MakeNetwork, statement: str
) -> None:
    a = networks()
    b = networks()
    tb = conn.execute(
        "insert into tag (network_id, kind, category, label)"
        " values (%s, 'skill', 'business', 'Marketing') returning id",
        (b.network_id,),
    ).fetchone()
    lb = conn.execute(
        "insert into contributor_link (network_id, person_id, token_hash)"
        " values (%s, %s, sha256('b'::bytea)) returning id",
        (b.network_id, b.admin_person_id),
    ).fetchone()
    assert tb is not None
    assert lb is not None
    user_id = uuid4()
    conn.execute("insert into auth.users (id) values (%s)", (user_id,))
    values = {
        "a": a.network_id,
        "pa": a.admin_person_id,
        "pb": b.admin_person_id,
        "qb": make_person(conn, b.network_id),
        "tb": tb[0],
        "lb": lb[0],
        "u": user_id,
    }
    query = sql.SQL(statement).format(**{k: sql.Literal(v) for k, v in values.items()})

    try:
        with pytest.raises(errors.ForeignKeyViolation):
            with db.user_tx(a.admin_claims, dsn=DSN) as tx:
                tx.execute(query)
    finally:
        conn.execute("delete from auth.users where id = %s", (user_id,))


def test_connection_pair_unique(conn: psycopg.Connection[Any], networks: MakeNetwork) -> None:
    network = networks()
    a, b = _pair(conn, network)
    insert = (
        "insert into connection (network_id, person_a, person_b, strength) values (%s, %s, %s, %s)"
    )

    with db.user_tx(network.admin_claims, dsn=DSN) as tx:
        tx.execute(insert, (network.network_id, a, b, "strong"))

    with pytest.raises(errors.UniqueViolation):
        with db.user_tx(network.admin_claims, dsn=DSN) as tx:
            tx.execute(insert, (network.network_id, a, b, "weak"))


def test_connection_self_loop_rejected(networks: MakeNetwork) -> None:
    network = networks()
    me = network.admin_person_id

    with pytest.raises(errors.CheckViolation):
        with db.user_tx(network.admin_claims, dsn=DSN) as tx:
            tx.execute(
                "insert into connection (network_id, person_a, person_b, strength)"
                " values (%s, %s, %s, 'strong')",
                (network.network_id, me, me),
            )


def _run_hook(
    conn: psycopg.Connection[Any], user_id: str, claims: dict[str, str]
) -> dict[str, Any]:
    """Call the hook as Supabase Auth does: as supabase_auth_admin, with the issued claims."""
    event = {"user_id": user_id, "claims": claims, "authentication_method": "password"}
    with conn.transaction():
        conn.execute("set local role supabase_auth_admin")
        row = conn.execute(
            "select public.custom_access_token_hook(%s::jsonb)", (json.dumps(event),)
        ).fetchone()
    assert row is not None
    return row[0]


def test_auth_hook_stamps_claims(conn: psycopg.Connection[Any], networks: MakeNetwork) -> None:
    network = networks()
    user_id = network.admin_claims["sub"]
    issued = {"sub": user_id, "role": "authenticated", "aal": "aal1", "aud": "authenticated"}

    result = _run_hook(conn, user_id, issued)

    assert result["user_id"] == user_id
    assert result["claims"] == {
        **issued,
        "network_id": str(network.network_id),
        "member_role": "admin",
        "person_id": str(network.admin_person_id),
    }
    assert result["claims"]["role"] == "authenticated", "the Postgres role claim is never touched"


def test_auth_hook_strips_claims_without_active_member(
    conn: psycopg.Connection[Any], networks: MakeNetwork
) -> None:
    network = networks()
    user_id = network.admin_claims["sub"]
    conn.execute("update member set status = 'disabled' where user_id = %s", (user_id,))
    stale = {**network.admin_claims, "aal": "aal1"}

    claims = _run_hook(conn, user_id, stale)["claims"]

    assert "network_id" not in claims
    assert "member_role" not in claims
    assert "person_id" not in claims
    assert claims["role"] == "authenticated"


def test_auth_hook_not_callable_by_request_roles(networks: MakeNetwork) -> None:
    network = networks()
    event = json.dumps({"user_id": network.admin_claims["sub"], "claims": {}})

    with pytest.raises(errors.InsufficientPrivilege):
        with db.user_tx(network.admin_claims, dsn=DSN) as tx:
            tx.execute("select public.custom_access_token_hook(%s::jsonb)", (event,))


def test_generated_columns_normalize(conn: psycopg.Connection[Any], networks: MakeNetwork) -> None:
    network = networks()
    nid = network.network_id
    person = make_person(conn, nid, name_ar="أحمد", name_latin="Ahmed  ALI")
    conn.execute(
        "insert into contact_value (network_id, person_id, kind, value) values"
        " (%s, %s, 'phone', '010 1234 5678'), (%s, %s, 'whatsapp', '00201012345678'),"
        " (%s, %s, 'email', ' Ahmed@Example.COM ')",
        (nid, person, nid, person, nid, person),
    )
    conn.execute(
        "insert into social_link (network_id, person_id, kind, url)"
        " values (%s, %s, 'github', 'HTTPS://www.GitHub.com/ahmed/')",
        (nid, person),
    )
    conn.execute(
        "insert into tag (network_id, kind, category, label)"
        " values (%s, 'skill', 'technical', '  Python ')",
        (nid,),
    )

    def one(query: str) -> object:
        row = conn.execute(query, (nid,)).fetchone()
        assert row is not None
        return row[0]

    assert one("select search_name from person where network_id = %s and name_ar is not null") == (
        "احمد ahmed ali"
    )
    assert sorted(
        r[0]
        for r in conn.execute("select value_norm from contact_value where network_id = %s", (nid,))
    ) == ["+201012345678", "+201012345678", "ahmed@example.com"]
    assert one("select url_norm from social_link where network_id = %s") == "github.com/ahmed"
    assert one("select label_norm from tag where network_id = %s") == "python"


def test_tag_category_only_for_skills(networks: MakeNetwork) -> None:
    network = networks()
    insert = "insert into tag (network_id, kind, category, label) values (%s, %s, %s, 'X')"

    for kind, category in [("skill", None), ("industry", "business")]:
        with pytest.raises(errors.CheckViolation):
            with db.user_tx(network.admin_claims, dsn=DSN) as tx:
                tx.execute(insert, (network.network_id, kind, category))


def test_user_tx_rolls_back_on_error(networks: MakeNetwork) -> None:
    network = networks()

    with pytest.raises(RuntimeError):
        with db.user_tx(network.admin_claims, dsn=DSN) as tx:
            tx.execute(
                "insert into person (network_id, name_latin) values (%s, 'Rolled Back')",
                (network.network_id,),
            )
            raise RuntimeError("boom")

    with db.user_tx(network.admin_claims, dsn=DSN) as tx:
        row = tx.execute("select count(*) from person where name_latin = 'Rolled Back'").fetchone()
    assert row == (0,)


def test_person_delete_cascades_and_nulls_provenance(
    conn: psycopg.Connection[Any], networks: MakeNetwork
) -> None:
    """Deleting a contributor removes their own data and edges; the people they added stay."""
    network = networks()
    nid = network.network_id
    contributor = make_person(conn, nid, name_latin="Contributor")
    added = conn.execute(
        "insert into person (network_id, name_latin, created_by_person_id)"
        " values (%s, 'Added', %s) returning id",
        (nid, contributor),
    ).fetchone()
    assert added is not None
    a, b = sorted([contributor, added[0]])
    conn.execute(
        "insert into connection (network_id, person_a, person_b, strength, created_by_person_id)"
        " values (%s, %s, %s, 'strong', %s)",
        (nid, a, b, contributor),
    )
    conn.execute(
        "insert into contact_value (network_id, person_id, kind, value, added_by_person_id)"
        " values (%s, %s, 'email', 'added@example.test', %s)",
        (nid, added[0], contributor),
    )
    conn.execute(
        "insert into contributor_link (network_id, person_id, token_hash)"
        " values (%s, %s, sha256('c'::bytea))",
        (nid, contributor),
    )

    conn.execute("delete from person where id = %s", (contributor,))

    assert conn.execute(
        "select network_id, created_by_person_id from person where id = %s", (added[0],)
    ).fetchone() == (nid, None)
    assert conn.execute(
        "select network_id, added_by_person_id from contact_value where person_id = %s",
        (added[0],),
    ).fetchone() == (nid, None)
    assert conn.execute(
        "select count(*) from connection where %s in (person_a, person_b)", (contributor,)
    ).fetchone() == (0,)
    assert conn.execute(
        "select count(*) from contributor_link where person_id = %s", (contributor,)
    ).fetchone() == (0,)
