"""Contributor links: admin link management and the no-account contributor endpoints.

The contributor path is the one request path with no JWT (spec 11.4): it runs as `anon` and
reaches data only through three SECURITY DEFINER functions that take the sha256 of the token.
These tests drive it over HTTP against a real database, and call the functions directly as
`anon` to prove they validate the payload themselves rather than trusting the API.

Fixture rows are written and read back as the superuser, outside RLS.

Skipped unless TEST_DATABASE_URL is set (CI always sets it).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from httpx import Response
from integration.helpers import (
    NetworkFixture,
    drop_network,
    make_network,
    make_person,
    token_for,
)
from psycopg import errors
from starlette.requests import Request

from connections_api import db
from connections_api.main import create_app
from connections_api.shared.rate_limit import contributor_token_key

DSN = os.environ.get("TEST_DATABASE_URL", "")
WEB_PUBLIC_URL = "http://localhost:4200"  # conftest's WEB_PUBLIC_URL
TOKEN_HEADER = "X-Contributor-Token"

pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL is not set")


@pytest.fixture
def conn() -> Iterator[psycopg.Connection[Any]]:
    """The superuser, autocommit: sets rows up and reads them back outside RLS."""
    with db.connect(DSN, autocommit=True) as connection:
        yield connection


@pytest.fixture
def network(conn: psycopg.Connection[Any]) -> Iterator[NetworkFixture]:
    fixture = make_network(conn)
    yield fixture
    drop_network(conn, fixture)


@pytest.fixture
def other_network(conn: psycopg.Connection[Any]) -> Iterator[NetworkFixture]:
    fixture = make_network(conn, name="Other network")
    yield fixture
    drop_network(conn, fixture)


@pytest.fixture
def admin(network: NetworkFixture) -> TestClient:
    return TestClient(
        create_app(), headers={"Authorization": f"Bearer {token_for(network.admin_claims)}"}
    )


@pytest.fixture
def anon() -> TestClient:
    """A contributor's browser: no session, no Authorization header."""
    return TestClient(create_app())


@pytest.fixture
def contributor(conn: psycopg.Connection[Any], network: NetworkFixture) -> UUID:
    """Person X, who receives the link (spec 8.2)."""
    return make_person(conn, network.network_id, name_ar="سامي", name_latin="Sami")


def token_of(url: str) -> str:
    return urlsplit(url).fragment


def create_link(admin: TestClient, person_id: UUID) -> dict[str, Any]:
    response = admin.post("/api/v1/links", json={"person_id": str(person_id)})
    assert response.status_code == 201, response.text
    return response.json()


def sha256(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def person_body(**overrides: object) -> dict[str, Any]:
    return {"name_latin": "Contributed Person", **overrides}


def contribute(
    anon: TestClient, token: str | None, strength: str = "normal", **person: object
) -> Response:
    headers = {} if token is None else {TOKEN_HEADER: token}
    return anon.post(
        "/api/v1/contribute/people",
        json={"person": person_body(**person), "strength": strength},
        headers=headers,
    )


def all_contributor_calls(anon: TestClient, token: str | None) -> list[Response]:
    headers = {} if token is None else {TOKEN_HEADER: token}
    return [
        anon.get("/api/v1/contribute/info", headers=headers),
        anon.get("/api/v1/contribute/tags", params={"kind": "skill", "q": "a"}, headers=headers),
        contribute(anon, token),
    ]


def assert_link_not_found(response: Response) -> dict[str, Any]:
    assert response.status_code == 404, response.text
    body = response.json()
    assert body["code"] == "link_not_found"
    body.pop("trace_id")
    return body


def count(conn: psycopg.Connection[Any], sql: str, *params: object) -> int:
    row = conn.execute(sql, params).fetchone()
    assert row is not None
    return row[0]


def expire(conn: psycopg.Connection[Any], link_id: str) -> None:
    conn.execute(
        "update contributor_link set expires_at = now() - interval '1 second' where id = %s",
        (link_id,),
    )


# -- admin: creating and listing links ----------------------------------------------------------


def test_create_link_url_uses_fragment(admin: TestClient, contributor: UUID) -> None:
    body = create_link(admin, contributor)

    url = urlsplit(body["url"])
    token = url.fragment
    assert "#" in body["url"]
    assert f"{url.scheme}://{url.netloc}" == WEB_PUBLIC_URL
    assert url.path == "/c"
    assert url.query == ""
    assert len(token) >= 43  # secrets.token_urlsafe(32)
    assert token not in url.path and token not in url.query
    expires_at = datetime.fromisoformat(body["expires_at"])
    assert abs(expires_at - (datetime.now(UTC) + timedelta(days=30))) < timedelta(minutes=1)
    UUID(body["link_id"])


def test_only_hash_stored(
    admin: TestClient, contributor: UUID, conn: psycopg.Connection[Any]
) -> None:
    body = create_link(admin, contributor)
    token = token_of(body["url"])

    row = conn.execute(
        "select token_hash, row_to_json(cl)::text from contributor_link cl where id = %s",
        (body["link_id"],),
    ).fetchone()
    assert row is not None
    assert bytes(row[0]) == sha256(token)
    assert token not in row[1]
    # The URL is returned once and never stored anywhere.
    assert token not in json.dumps(admin.get("/api/v1/links").json())


def test_create_link_for_unknown_person_is_422(
    admin: TestClient, other_network: NetworkFixture
) -> None:
    for person_id in (uuid4(), other_network.admin_person_id):
        response = admin.post("/api/v1/links", json={"person_id": str(person_id)})
        assert response.status_code == 422, response.text
        assert response.json()["details"] == {"field": "person_id", "reason": "person_not_found"}


def test_list_links_counts_people_added(
    admin: TestClient, anon: TestClient, contributor: UUID, network: NetworkFixture
) -> None:
    first = create_link(admin, contributor)
    second = create_link(admin, network.admin_person_id)
    for _ in range(2):
        assert contribute(anon, token_of(first["url"])).status_code == 201
    admin.post(f"/api/v1/links/{second['link_id']}/revoke")

    links = {item["link_id"]: item for item in admin.get("/api/v1/links").json()}

    assert links[first["link_id"]]["person_id"] == str(contributor)
    assert links[first["link_id"]]["display_name"] == "سامي"
    assert links[first["link_id"]]["people_added"] == 2
    assert links[first["link_id"]]["revoked_at"] is None
    assert links[second["link_id"]]["people_added"] == 0
    assert links[second["link_id"]]["revoked_at"] is not None
    assert set(links[first["link_id"]]) == {
        "link_id", "person_id", "display_name", "expires_at", "revoked_at", "people_added",
    }  # fmt: skip


def test_link_admin_endpoints_need_admin(anon: TestClient) -> None:
    link_id = uuid4()
    for response in (
        anon.post("/api/v1/links", json={"person_id": str(uuid4())}),
        anon.get("/api/v1/links"),
        anon.post(f"/api/v1/links/{link_id}/renew"),
        anon.post(f"/api/v1/links/{link_id}/revoke"),
    ):
        assert response.status_code == 401, response.text


def test_links_of_other_network_are_invisible(
    admin: TestClient, other_network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    foreign = conn.execute(
        "insert into contributor_link (network_id, person_id, token_hash)"
        " values (%s, %s, %s) returning id",
        (other_network.network_id, other_network.admin_person_id, sha256("foreign")),
    ).fetchone()
    assert foreign is not None

    assert str(foreign[0]) not in {item["link_id"] for item in admin.get("/api/v1/links").json()}
    assert admin.post(f"/api/v1/links/{foreign[0]}/renew").status_code == 404
    assert admin.post(f"/api/v1/links/{foreign[0]}/revoke").status_code == 404


# -- contributor: the happy path ----------------------------------------------------------------


def test_contribute_info_greets_the_contributor(
    admin: TestClient, anon: TestClient, contributor: UUID
) -> None:
    body = create_link(admin, contributor)

    response = anon.get("/api/v1/contribute/info", headers={TOKEN_HEADER: token_of(body["url"])})

    assert response.status_code == 200, response.text
    assert response.json()["contributor_display_name"] == "سامي"
    assert response.json()["expires_at"] == body["expires_at"]


def test_contribute_creates_person_connected_to_contributor(
    admin: TestClient,
    anon: TestClient,
    contributor: UUID,
    network: NetworkFixture,
    conn: psycopg.Connection[Any],
) -> None:
    link = create_link(admin, contributor)

    response = contribute(
        anon,
        token_of(link["url"]),
        strength="strong",
        name_ar="منى",
        headline="Growth lead",
        seniority="manager",
        available_for=["freelance", "freelance"],
        city="Cairo",
        skills=[
            {"label": "Marketing", "category": "business", "level": "expert"},
            {"label": " marketing ", "category": "business"},
        ],
        industries=["Retail", "retail"],
        social_links=[{"kind": "linkedin", "url": "https://linkedin.com/in/mona"}],
        contacts=[
            {"kind": "phone", "value": "010 1234 5678"},
            {"kind": "phone", "value": "010 1234 5678"},
            {"kind": "email", "value": "mona@example.test"},
        ],
    )

    assert response.status_code == 201, response.text
    assert set(response.json()) == {"person_id"}
    person_id = response.json()["person_id"]
    person = conn.execute(
        "select network_id, created_via::text, contributor_link_id, created_by_person_id,"
        " name_ar, headline, seniority::text, available_for, city, admin_notes"
        " from person where id = %s",
        (person_id,),
    ).fetchone()
    assert person == (
        network.network_id, "link", UUID(link["link_id"]), contributor, "منى", "Growth lead",
        "manager", ["freelance"], "Cairo", None,
    )  # fmt: skip
    a, b = sorted((UUID(person_id), contributor))
    assert conn.execute(
        "select strength::text, created_by_person_id from connection"
        " where person_a = %s and person_b = %s",
        (a, b),
    ).fetchall() == [("strong", contributor)]
    assert count(conn, "select count(*) from connection where %s in (person_a, person_b)",
                 UUID(person_id)) == 1  # fmt: skip
    contacts = conn.execute(
        "select cv.kind::text, cv.value, cv.added_by_person_id from contact_value cv"
        " where cv.person_id = %s order by cv.kind, cv.value",
        (person_id,),
    ).fetchall()
    assert contacts == [
        ("phone", "010 1234 5678", contributor),
        ("email", "mona@example.test", contributor),
    ]
    assert conn.execute(
        "select t.label, t.category::text, ps.level::text from person_skill ps"
        " join tag t on t.id = ps.tag_id where ps.person_id = %s",
        (person_id,),
    ).fetchall() == [("Marketing", "business", "expert")]
    assert conn.execute(
        "select t.label from person_industry pi join tag t on t.id = pi.tag_id"
        " where pi.person_id = %s",
        (person_id,),
    ).fetchall() == [("Retail",)]
    assert conn.execute(
        "select kind::text, url from social_link where person_id = %s", (person_id,)
    ).fetchall() == [("linkedin", "https://linkedin.com/in/mona")]


def test_contribute_reuses_existing_tag_spelling(
    admin: TestClient,
    anon: TestClient,
    contributor: UUID,
    network: NetworkFixture,
    conn: psycopg.Connection[Any],
) -> None:
    conn.execute(
        "insert into tag (network_id, kind, category, label) values (%s, 'skill', 'business',"
        " 'Marketing')",
        (network.network_id,),
    )
    token = token_of(create_link(admin, contributor)["url"])

    response = contribute(anon, token, skills=[{"label": "MARKETING", "category": "other"}])

    assert response.status_code == 201, response.text
    assert count(conn, "select count(*) from tag where network_id = %s and kind = 'skill'",
                 network.network_id) == 1  # fmt: skip


def test_contributor_cannot_send_admin_notes(
    admin: TestClient, anon: TestClient, contributor: UUID, conn: psycopg.Connection[Any]
) -> None:
    token = token_of(create_link(admin, contributor)["url"])
    before = count(conn, "select count(*) from person")

    response = contribute(anon, token, admin_notes="owes me money")

    assert response.status_code == 422, response.text
    assert count(conn, "select count(*) from person") == before


@pytest.mark.parametrize(
    "body",
    [
        {"person": person_body()},  # strength is required
        {"person": person_body(), "strength": "close"},
        {"person": {"name_latin": "  "}, "strength": "normal"},
        {"person": person_body(), "strength": "normal", "connect_to_person_id": str(uuid4())},
        {"person": person_body(skills=[{"label": "x", "category": "business"}] * 51),
         "strength": "normal"},
    ],
)  # fmt: skip
def test_contribute_rejects_invalid_body(
    admin: TestClient, anon: TestClient, contributor: UUID, body: dict[str, Any]
) -> None:
    token = token_of(create_link(admin, contributor)["url"])

    response = anon.post("/api/v1/contribute/people", json=body, headers={TOKEN_HEADER: token})

    assert response.status_code == 422, response.text


# -- contributor: every bad token is the same 404 -----------------------------------------------


def test_expired_link_404(
    admin: TestClient, anon: TestClient, contributor: UUID, conn: psycopg.Connection[Any]
) -> None:
    link = create_link(admin, contributor)
    expire(conn, link["link_id"])
    before = count(conn, "select count(*) from person")

    for response in all_contributor_calls(anon, token_of(link["url"])):
        assert_link_not_found(response)
    assert count(conn, "select count(*) from person") == before


def test_revoked_link_404(admin: TestClient, anon: TestClient, contributor: UUID) -> None:
    link = create_link(admin, contributor)
    token = token_of(link["url"])
    assert contribute(anon, token).status_code == 201

    revoked = admin.post(f"/api/v1/links/{link['link_id']}/revoke")
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["revoked_at"] is not None

    for response in all_contributor_calls(anon, token):
        assert_link_not_found(response)


def test_unknown_token_404(anon: TestClient) -> None:
    for response in all_contributor_calls(anon, secrets.token_urlsafe(32)):
        assert_link_not_found(response)


def test_missing_header_404(anon: TestClient) -> None:
    for response in all_contributor_calls(anon, None):
        assert_link_not_found(response)


def test_every_bad_token_gets_the_same_body(
    admin: TestClient, anon: TestClient, contributor: UUID, conn: psycopg.Connection[Any]
) -> None:
    expired = create_link(admin, contributor)
    expire(conn, expired["link_id"])
    revoked = create_link(admin, contributor)
    admin.post(f"/api/v1/links/{revoked['link_id']}/revoke")
    bad_tokens: list[str | None] = [
        None,
        "",
        "not a token!",
        "x" * 2000,
        "' or 1=1 --",
        secrets.token_urlsafe(32),
        token_of(expired["url"]),
        token_of(revoked["url"]),
    ]

    bodies = [
        assert_link_not_found(response)
        for token in bad_tokens
        for response in all_contributor_calls(anon, token)
    ]

    assert all(body == bodies[0] for body in bodies)


# -- renew and revoke ---------------------------------------------------------------------------


def test_renew_invalidates_old_token(
    admin: TestClient, anon: TestClient, contributor: UUID, conn: psycopg.Connection[Any]
) -> None:
    link = create_link(admin, contributor)
    old_token = token_of(link["url"])
    expire(conn, link["link_id"])  # renewing is how an expired link comes back

    response = admin.post(f"/api/v1/links/{link['link_id']}/renew")

    assert response.status_code == 200, response.text
    renewed = response.json()
    new_token = token_of(renewed["url"])
    assert renewed["link_id"] == link["link_id"]
    assert new_token != old_token
    expires_at = datetime.fromisoformat(renewed["expires_at"])
    assert abs(expires_at - (datetime.now(UTC) + timedelta(days=30))) < timedelta(minutes=1)
    for call in all_contributor_calls(anon, old_token):
        assert_link_not_found(call)
    assert anon.get("/api/v1/contribute/info", headers={TOKEN_HEADER: new_token}).status_code == 200
    assert contribute(anon, new_token).status_code == 201


def test_renew_revoked_link_is_409(admin: TestClient, anon: TestClient, contributor: UUID) -> None:
    link = create_link(admin, contributor)
    admin.post(f"/api/v1/links/{link['link_id']}/revoke")

    response = admin.post(f"/api/v1/links/{link['link_id']}/renew")

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "link_revoked"
    assert_link_not_found(contribute(anon, token_of(link["url"])))


def test_revoke_is_idempotent(admin: TestClient, contributor: UUID) -> None:
    link = create_link(admin, contributor)

    first = admin.post(f"/api/v1/links/{link['link_id']}/revoke").json()
    second = admin.post(f"/api/v1/links/{link['link_id']}/revoke").json()

    assert first["revoked_at"] == second["revoked_at"]


def test_renew_and_revoke_unknown_link_404(admin: TestClient) -> None:
    assert admin.post(f"/api/v1/links/{uuid4()}/renew").status_code == 404
    assert admin.post(f"/api/v1/links/{uuid4()}/revoke").status_code == 404


# -- only contributor_api reaches the three functions, and nothing else ---------------------------

CONTRIBUTOR_FUNCTIONS = [
    ("public.contributor_link_info(bytea)", "select * from public.contributor_link_info(%s)"),
    (
        "public.contribute_person(bytea, jsonb)",
        "select public.contribute_person(%s, '{}'::jsonb)",
    ),
    (
        "public.contributor_tag_suggest(bytea, text, text)",
        "select * from public.contributor_tag_suggest(%s, 'skill', 'x')",
    ),
]


type OpenTx = Callable[[], AbstractContextManager[psycopg.Connection[Any]]]


def as_contributor_api() -> AbstractContextManager[psycopg.Connection[Any]]:
    return db.contributor_tx(dsn=DSN)


def as_anon() -> AbstractContextManager[psycopg.Connection[Any]]:
    return db.user_tx({}, dsn=DSN)


@pytest.mark.parametrize("table", ["person", "contact_value", "contributor_link", "tag"])
@pytest.mark.parametrize(
    ("open_tx", "role"), [(as_anon, "anon"), (as_contributor_api, "contributor_api")]
)
def test_anon_cannot_select_tables(table: str, open_tx: OpenTx, role: str) -> None:
    with pytest.raises(errors.InsufficientPrivilege):
        with open_tx() as tx:
            assert tx.execute("select current_user").fetchone() == (role,)
            tx.execute(f"select count(*) from public.{table}")  # noqa: S608


@pytest.mark.parametrize(
    ("sql", "params"),
    [
        ("insert into public.person (network_id, name_latin) values (%s, 'x')", (uuid4(),)),
        ("select public.upsert_tag(%s, 'skill', 'x', 'other')", (uuid4(),)),
        ("select public.merge_persons(%s, %s)", (uuid4(), uuid4())),
        ("select * from public.suggest_tags(%s, 'skill', 'x')", (uuid4(),)),
    ],
)
@pytest.mark.parametrize("open_tx", [as_anon, as_contributor_api])
def test_no_session_roles_cannot_write_or_call_internal_functions(
    sql: str,
    params: tuple[object],
    open_tx: OpenTx,
) -> None:
    with pytest.raises(errors.InsufficientPrivilege):
        with open_tx() as tx:
            tx.execute(sql, params)


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize(("_signature", "sql"), CONTRIBUTOR_FUNCTIONS)
def test_supabase_roles_cannot_execute_contributor_functions(
    role: str, _signature: str, sql: str
) -> None:
    """PostgREST serves public functions to anon (the anon key is public) and to signed-in users:
    a direct /rest/v1/rpc call must not get around the API's rate limits."""
    with db.connect(DSN) as connection, connection.transaction():
        connection.execute(f"set local role {role}")
        with pytest.raises(errors.InsufficientPrivilege):
            connection.execute(sql, (sha256("x"),))


@pytest.mark.parametrize(("signature", "_sql"), CONTRIBUTOR_FUNCTIONS)
def test_contributor_functions_are_contributor_api_only_definers(
    signature: str, _sql: str, conn: psycopg.Connection[Any]
) -> None:
    row = conn.execute(
        "select p.prosecdef, p.proconfig,"
        " has_function_privilege('contributor_api', p.oid, 'execute'),"
        " has_function_privilege('anon', p.oid, 'execute'),"
        " has_function_privilege('authenticated', p.oid, 'execute'),"
        " has_function_privilege('service_role', p.oid, 'execute'),"
        " exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)"  # PUBLIC
        " from pg_proc p where p.oid = %s::regprocedure",
        (signature,),
    ).fetchone()
    assert row == (True, ['search_path=""'], True, False, False, False, False)


def test_contributor_api_role_is_narrow(conn: psycopg.Connection[Any]) -> None:
    role = conn.execute(
        "select rolcanlogin, rolsuper, rolbypassrls, rolinherit from pg_roles"
        " where rolname = 'contributor_api'"
    ).fetchone()
    assert role == (False, False, False, True)
    # The API's login role may switch to it; nothing else (PostgREST's authenticator above all).
    members = conn.execute(
        "select m.member::regrole::text from pg_auth_members m"
        " where m.roleid = 'contributor_api'::regrole"
    ).fetchall()
    assert members == [("postgres",)]
    # No privilege on any table.
    assert conn.execute(
        "select count(*) from information_schema.role_table_grants"
        " where grantee = 'contributor_api'"
    ).fetchone() == (0,)


# -- contribute_person validates its payload itself ---------------------------------------------


@pytest.fixture
def link_hash(conn: psycopg.Connection[Any], network: NetworkFixture, contributor: UUID) -> bytes:
    token_hash = sha256(secrets.token_urlsafe(32))
    conn.execute(
        "insert into contributor_link (network_id, person_id, token_hash) values (%s, %s, %s)",
        (network.network_id, contributor, token_hash),
    )
    return token_hash


def call_contribute_person(token_hash: bytes, payload: object) -> UUID:
    with db.contributor_tx(dsn=DSN) as tx:
        row = tx.execute(
            "select public.contribute_person(%s, %s::jsonb)", (token_hash, json.dumps(payload))
        ).fetchone()
    assert row is not None
    return row[0]


def test_contribute_person_accepts_a_minimal_payload(link_hash: bytes) -> None:
    person_id = call_contribute_person(
        link_hash, {"person": {"name_ar": "نور"}, "strength": "weak"}
    )
    assert isinstance(person_id, UUID)


def test_contribute_person_raises_invalid_link(link_hash: bytes) -> None:
    with pytest.raises(errors.InvalidAuthorizationSpecification, match="invalid_link"):
        call_contribute_person(sha256("unknown"), {"person": {"name_ar": "x"}, "strength": "weak"})


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"person": {"name_latin": "x"}},
        {"person": {"name_latin": "x"}, "strength": "close"},
        {"person": {"name_latin": "   "}, "strength": "weak"},
        {"person": {}, "strength": "weak"},
        {"person": "x", "strength": "weak"},
        {"person": {"name_latin": "x", "admin_notes": "secret"}, "strength": "weak"},
        {"person": {"name_latin": "x", "created_via": "admin"}, "strength": "weak"},
        {"person": {"name_latin": "x" * 201}, "strength": "weak"},
        {"person": {"name_latin": 5}, "strength": "weak"},
        {"person": {"name_latin": "x", "seniority": "ceo"}, "strength": "weak"},
        {"person": {"name_latin": "x", "available_for": ["sleeping"]}, "strength": "weak"},
        {"person": {"name_latin": "x", "available_for": "freelance"}, "strength": "weak"},
        {"person": {"name_latin": "x", "skills": [{"label": "a", "category": "magic"}]},
         "strength": "weak"},
        {"person": {"name_latin": "x", "skills": [{"label": " ", "category": "other"}]},
         "strength": "weak"},
        {"person": {"name_latin": "x", "skills": [{"label": "a", "category": "other"}] * 51},
         "strength": "weak"},
        {"person": {"name_latin": "x", "industries": ["a"] * 21}, "strength": "weak"},
        {"person": {"name_latin": "x", "industries": [5]}, "strength": "weak"},
        {"person": {"name_latin": "x", "social_links": [{"kind": "myspace", "url": "u"}]},
         "strength": "weak"},
        {"person": {"name_latin": "x", "contacts": [{"kind": "fax", "value": "1"}]},
         "strength": "weak"},
        {"person": {"name_latin": "x", "contacts": [{"kind": "email", "value": "a@b.c"}] * 21},
         "strength": "weak"},
    ],
)  # fmt: skip
def test_contribute_person_validates_payload(
    link_hash: bytes, payload: object, conn: psycopg.Connection[Any]
) -> None:
    before = count(conn, "select count(*) from person")

    with pytest.raises(psycopg.DataError):
        call_contribute_person(link_hash, payload)

    assert count(conn, "select count(*) from person") == before


# -- tag suggestions ----------------------------------------------------------------------------


def test_contributor_tag_suggest_needs_valid_link(
    admin: TestClient,
    anon: TestClient,
    contributor: UUID,
    network: NetworkFixture,
    other_network: NetworkFixture,
    conn: psycopg.Connection[Any],
) -> None:
    conn.execute(
        "insert into tag (network_id, kind, category, label) values"
        " (%(n)s, 'skill', 'business', 'marketing'), (%(n)s, 'industry', null, 'Maritime'),"
        " (%(o)s, 'skill', 'business', 'Marketplace design')",
        {"n": network.network_id, "o": other_network.network_id},
    )
    link = create_link(admin, contributor)
    headers = {TOKEN_HEADER: token_of(link["url"])}

    response = anon.get("/api/v1/contribute/tags", params={"kind": "skill", "q": "mar"},
                        headers=headers)  # fmt: skip

    assert response.status_code == 200, response.text
    assert response.json() == [{"label": "marketing", "category": "business"}]
    industries = anon.get(
        "/api/v1/contribute/tags", params={"kind": "industry", "q": "mar"}, headers=headers
    )
    assert industries.json() == [{"label": "Maritime", "category": None}]
    assert (
        anon.get(
            "/api/v1/contribute/tags", params={"kind": "person", "q": "mar"}, headers=headers
        ).status_code
        == 422
    )

    expire(conn, link["link_id"])
    assert_link_not_found(
        anon.get("/api/v1/contribute/tags", params={"kind": "skill", "q": "mar"}, headers=headers)
    )


# -- rate limiting ------------------------------------------------------------------------------


def test_rate_limit_429(admin: TestClient, anon: TestClient, contributor: UUID) -> None:
    token = token_of(create_link(admin, contributor)["url"])
    other_token = token_of(create_link(admin, contributor)["url"])

    for _ in range(30):
        assert contribute(anon, token).status_code == 201

    limited = contribute(anon, token)
    assert limited.status_code == 429, limited.text
    assert limited.json()["code"] == "rate_limit.exceeded"
    # The bucket is the token's: another link from the same address still gets through.
    assert contribute(anon, other_token).status_code == 201


def test_rate_limit_per_ip(anon: TestClient) -> None:
    for _ in range(60):
        response = anon.get(
            "/api/v1/contribute/info", headers={TOKEN_HEADER: secrets.token_urlsafe(32)}
        )
        assert response.status_code == 404

    limited = anon.get("/api/v1/contribute/info", headers={TOKEN_HEADER: secrets.token_urlsafe(32)})
    assert limited.status_code == 429, limited.text


# -- logs ---------------------------------------------------------------------------------------


def test_contribute_does_not_log_token(
    admin: TestClient,
    anon: TestClient,
    contributor: UUID,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    link = create_link(admin, contributor)
    token = token_of(link["url"])
    caplog.set_level(logging.DEBUG)

    anon.get("/api/v1/contribute/info", headers={TOKEN_HEADER: token})
    anon.get("/api/v1/contribute/tags", params={"kind": "skill", "q": "m"},
             headers={TOKEN_HEADER: token})  # fmt: skip
    for _ in range(31):  # the last one is rate limited, which slowapi logs with its bucket key
        contribute(anon, token)
    admin.post(f"/api/v1/links/{link['link_id']}/revoke")
    anon.get("/api/v1/contribute/info", headers={TOKEN_HEADER: token})

    assert any("exceeded" in record.getMessage() for record in caplog.records)
    # Neither the token nor its stored hash (the functions' credential) reaches a log line.
    out = capsys.readouterr().out
    for secret in (token, sha256(token).hex()):
        assert secret not in caplog.text
        for record in caplog.records:
            assert secret not in record.getMessage()
            assert secret not in repr(record.__dict__)
        assert secret not in out


def test_rate_limit_key_is_not_the_stored_hash(
    admin: TestClient, contributor: UUID, conn: psycopg.Connection[Any]
) -> None:
    link = create_link(admin, contributor)
    token = token_of(link["url"])
    stored = conn.execute(
        "select token_hash from contributor_link where id = %s", (link["link_id"],)
    ).fetchone()
    assert stored is not None
    request = Request(
        {"type": "http", "headers": [(TOKEN_HEADER.lower().encode(), token.encode())]}
    )

    key = contributor_token_key(request)

    assert key == contributor_token_key(request)  # stable: one bucket per link
    assert bytes(stored[0]).hex() not in key
    assert token not in key
