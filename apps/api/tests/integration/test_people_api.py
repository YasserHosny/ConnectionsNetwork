"""People, connections and tag autocomplete over HTTP, against a real database under RLS.

Requests carry a real (HS256, test-secret) admin token, so they pass through current_admin and
admin_tx exactly as in production. Fixture rows are written as the superuser, outside RLS.

Skipped unless TEST_DATABASE_URL is set (CI always sets it).
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from httpx import Response
from integration.helpers import NetworkFixture, drop_network, make_network, make_person
from jose import jwt

from connections_api import db
from connections_api.main import create_app

DSN = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL is not set")

JWT_SECRET = "test-secret-value-not-used-anywhere-real"


def token_for(claims: dict[str, str]) -> str:
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
def client(network: NetworkFixture) -> TestClient:
    return TestClient(
        create_app(), headers={"Authorization": f"Bearer {token_for(network.admin_claims)}"}
    )


def person_body(**overrides: object) -> dict[str, Any]:
    return {"name_latin": "New Person", **overrides}


def create(
    client: TestClient,
    network: NetworkFixture,
    *,
    connect_to: UUID | None = None,
    strength: str = "normal",
    note: str | None = None,
    **person: object,
) -> dict[str, Any]:
    response = client.post(
        "/api/v1/people",
        json={
            "person": person_body(**person),
            "connect_to_person_id": str(connect_to or network.admin_person_id),
            "strength": strength,
            "connection_note": note,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def count(conn: psycopg.Connection[Any], sql: str, *params: object) -> int:
    row = conn.execute(sql, params).fetchone()
    assert row is not None
    return row[0]


# -- create -------------------------------------------------------------------------------------


def test_create_person_connects_to_admin(client: TestClient, network: NetworkFixture) -> None:
    body = create(client, network, strength="strong", note="Colleagues", name_ar="سعيد")

    connections = body["person"]["connections"]
    assert len(connections) == 1
    assert connections[0]["person_id"] == str(network.admin_person_id)
    assert connections[0]["display_name"] == "Network Admin"
    assert connections[0]["strength"] == "strong"
    assert connections[0]["note"] == "Colleagues"
    assert body["person"]["name_ar"] == "سعيد"
    assert body["person"]["created_by_person_id"] == str(network.admin_person_id)
    assert body["person"]["is_stale"] is False


def test_create_on_behalf_connects_to_other(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    x = make_person(conn, network.network_id, name_latin="Person X")

    body = create(client, network, connect_to=x, strength="weak")

    connections = body["person"]["connections"]
    assert [c["person_id"] for c in connections] == [str(x)]
    assert connections[0]["strength"] == "weak"
    # Not to the admin: that is spec 8.3, adding on someone's behalf.
    assert (
        count(
            conn,
            "select count(*) from connection where network_id = %s"
            " and %s in (person_a, person_b) and %s in (person_a, person_b)",
            network.network_id,
            network.admin_person_id,
            UUID(body["person"]["id"]),
        )
        == 0
    )


def test_create_orders_the_pair_whichever_way_the_ids_sort(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    # The schema requires person_a < person_b; random ids land on either side.
    for _ in range(6):
        body = create(client, network, connect_to=network.admin_person_id)
        assert len(body["person"]["connections"]) == 1
    assert count(conn, "select count(*) from connection where person_a >= person_b") == 0


@pytest.mark.parametrize("person", [{"name_ar": None, "name_latin": None}, {"name_latin": "  "}])
def test_create_requires_a_name(
    client: TestClient, network: NetworkFixture, person: dict[str, Any]
) -> None:
    response = client.post(
        "/api/v1/people",
        json={
            "person": person,
            "connect_to_person_id": str(network.admin_person_id),
            "strength": "normal",
        },
    )

    assert response.status_code == 422


@pytest.mark.parametrize(
    "patch",
    [
        {"strength": "best"},
        {"person": {"name_latin": "A", "seniority": "ceo"}},
        {"person": {"name_latin": "A", "available_for": ["napping"]}},
        {"person": {"name_latin": "A", "skills": [{"label": "Go"}]}},
        {"person": {"name_latin": "A", "skills": [{"label": "Go", "category": "x"}]}},
        {
            "person": {
                "name_latin": "A",
                "skills": [{"label": "Go", "category": "other", "level": "god"}],
            }
        },
        {"person": {"name_latin": "A", "social_links": [{"kind": "myspace", "url": "x.com/a"}]}},
        {"person": {"name_latin": "A", "contacts": [{"kind": "fax", "value": "1"}]}},
    ],
)
def test_create_rejects_values_outside_the_value_sets(
    client: TestClient, network: NetworkFixture, patch: dict[str, Any]
) -> None:
    payload: dict[str, Any] = {
        "person": {"name_latin": "A"},
        "connect_to_person_id": str(network.admin_person_id),
        "strength": "normal",
        **patch,
    }

    assert client.post("/api/v1/people", json=payload).status_code == 422


def test_create_with_unknown_connect_target_is_422_and_creates_nothing(
    client: TestClient,
    network: NetworkFixture,
    other_network: NetworkFixture,
    conn: psycopg.Connection[Any],
) -> None:
    before = count(conn, "select count(*) from person where network_id = %s", network.network_id)

    for target in (uuid4(), other_network.admin_person_id):  # nowhere, and another network's
        response = client.post(
            "/api/v1/people",
            json={
                "person": person_body(),
                "connect_to_person_id": str(target),
                "strength": "normal",
            },
        )
        assert response.status_code == 422
        assert response.json()["details"]["field"] == "connect_to_person_id"

    assert (
        count(conn, "select count(*) from person where network_id = %s", network.network_id)
        == before
    )


def test_create_stores_the_whole_profile(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    body = create(
        client,
        network,
        name_ar="ليلى",
        headline="CTO",
        organization="Acme",
        profession="Developer",
        seniority="decision_maker",
        available_for=["freelance", "job_seeking"],
        city="Cairo",
        country="Egypt",
        admin_notes="met at a wedding",
        skills=[{"label": "Python", "category": "technical", "level": "expert"}],
        industries=["Banking"],
        social_links=[{"kind": "linkedin", "url": "https://linkedin.com/in/laila"}],
        contacts=[
            {"kind": "phone", "value": "01012345678"},
            {"kind": "email", "value": "Laila@Example.com"},
        ],
    )

    person = body["person"]
    assert person["headline"] == "CTO"
    assert person["seniority"] == "decision_maker"
    assert sorted(person["available_for"]) == ["freelance", "job_seeking"]
    assert person["admin_notes"] == "met at a wedding"
    assert [(s["label"], s["category"], s["level"]) for s in person["skills"]] == [
        ("Python", "technical", "expert")
    ]
    assert [i["label"] for i in person["industries"]] == ["Banking"]
    assert [(link["kind"], link["url"]) for link in person["social_links"]] == [
        ("linkedin", "https://linkedin.com/in/laila")
    ]
    assert {(c["kind"], c["value"]) for c in person["contacts"]} == {
        ("phone", "01012345678"),
        ("email", "Laila@Example.com"),
    }
    # Every contact value records who entered it (spec 7.2).
    assert {c["added_by_person_id"] for c in person["contacts"]} == {str(network.admin_person_id)}
    assert client.get(f"/api/v1/people/{person['id']}").json() == person


# -- tags ---------------------------------------------------------------------------------------


def tag_rows(conn: psycopg.Connection[Any], network: NetworkFixture, kind: str) -> list[Any]:
    return conn.execute(
        "select id, label, category from tag where network_id = %s and kind = %s",
        (network.network_id, kind),
    ).fetchall()


def test_create_reuses_tag_variants(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    first = create(
        client,
        network,
        skills=[{"label": "Marketing", "category": "business"}],
        industries=["Banking"],
    )
    second = create(
        client,
        network,
        skills=[{"label": " marketing ", "category": "business", "level": "good"}],
        industries=["  BANKING"],
    )

    assert len(tag_rows(conn, network, "skill")) == 1
    assert len(tag_rows(conn, network, "industry")) == 1
    assert first["person"]["skills"][0]["tag_id"] == second["person"]["skills"][0]["tag_id"]
    assert second["person"]["skills"][0]["label"] == "Marketing"  # the first spelling is kept


def test_create_reuses_arabic_spelling_variants(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    create(client, network, skills=[{"label": "تسويق رقمية", "category": "business"}])
    create(client, network, skills=[{"label": "تسويق رقميه", "category": "business"}])  # ة / ه

    assert len(tag_rows(conn, network, "skill")) == 1


def test_same_label_in_two_variants_on_one_person_stores_one_skill(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    body = create(
        client,
        network,
        skills=[
            {"label": "Sales", "category": "business"},
            {"label": "sales ", "category": "business", "level": "good"},
        ],
    )

    assert [(s["label"], s["level"]) for s in body["person"]["skills"]] == [("Sales", "good")]


def test_alias_resolves(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    marketing = create(client, network, skills=[{"label": "marketing", "category": "business"}])
    target_id = marketing["person"]["skills"][0]["tag_id"]
    alias_id = conn.execute(
        "insert into tag (network_id, kind, category, label, alias_of_tag_id)"
        " values (%s, 'skill', 'business', 'mktg', %s) returning id",
        (network.network_id, target_id),
    ).fetchone()[0]  # type: ignore[index]

    body = create(client, network, skills=[{"label": "mktg", "category": "business"}])

    assert body["person"]["skills"][0]["tag_id"] == target_id
    assert body["person"]["skills"][0]["label"] == "marketing"
    assert count(conn, "select count(*) from person_skill where tag_id = %s", alias_id) == 0
    assert len(tag_rows(conn, network, "skill")) == 2  # marketing and the alias; none added


def test_tags_autocomplete_arabic(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    create(client, network, skills=[{"label": "تسويق", "category": "business"}])

    response = client.get("/api/v1/tags", params={"kind": "skill", "q": "تسو"})

    assert response.status_code == 200
    assert [(t["label"], t["category"]) for t in response.json()] == [("تسويق", "business")]
    # Spelling variants of the query still find it (ة/ه folding, harakat).
    create(client, network, skills=[{"label": "مدرسة", "category": "other"}])
    found = client.get("/api/v1/tags", params={"kind": "skill", "q": "مَدرَسه"}).json()
    assert [t["label"] for t in found] == ["مدرسة"]


def test_tags_autocomplete_prefix_then_similarity_and_aliases(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    for label in ("Marketing", "Market research", "Supermarket logistics"):
        create(client, network, skills=[{"label": label, "category": "business"}])
    create(client, network, industries=["Marketplace"])
    marketing = conn.execute(
        "select id from tag where network_id = %s and label = 'Marketing'", (network.network_id,)
    ).fetchone()[0]  # type: ignore[index]
    conn.execute(
        "insert into tag (network_id, kind, category, label, alias_of_tag_id)"
        " values (%s, 'skill', 'business', 'mktg', %s)",
        (network.network_id, marketing),
    )

    skills = client.get("/api/v1/tags", params={"kind": "skill", "q": "mark"}).json()
    # Prefix matches only, the closer (shorter) label first; "Supermarket logistics" has no prefix.
    assert [t["label"] for t in skills] == ["Marketing", "Market research"]

    # No prefix match: trigram similarity finds the typo, still ranked after prefixes.
    typo = client.get("/api/v1/tags", params={"kind": "skill", "q": "marketng"}).json()
    assert "Marketing" in [t["label"] for t in typo]

    # An alias answers with its target, once.
    aliased = client.get("/api/v1/tags", params={"kind": "skill", "q": "mkt"}).json()
    assert [t["label"] for t in aliased] == ["Marketing"]
    assert aliased[0]["id"] == str(marketing)

    # Kind filter, industries carry no category.
    industries = client.get("/api/v1/tags", params={"kind": "industry", "q": "mark"}).json()
    assert [(t["label"], t["category"]) for t in industries] == [("Marketplace", None)]


def test_tags_autocomplete_returns_at_most_ten_and_validates_kind(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    for i in range(12):
        conn.execute(
            "insert into tag (network_id, kind, label) values (%s, 'industry', %s)",
            (network.network_id, f"Sector {i:02d}"),
        )

    assert len(client.get("/api/v1/tags", params={"kind": "industry", "q": "sec"}).json()) == 10
    assert len(client.get("/api/v1/tags", params={"kind": "industry"}).json()) == 10
    assert client.get("/api/v1/tags", params={"kind": "hobby"}).status_code == 422
    assert client.get("/api/v1/tags").status_code == 422


def test_tags_are_scoped_to_the_network(
    client: TestClient,
    network: NetworkFixture,
    other_network: NetworkFixture,
    conn: psycopg.Connection[Any],
) -> None:
    conn.execute(
        "insert into tag (network_id, kind, category, label)"
        " values (%s, 'skill', 'other', 'Secret')",
        (other_network.network_id,),
    )

    assert client.get("/api/v1/tags", params={"kind": "skill", "q": "sec"}).json() == []


# -- upsert_tag (SQL) ---------------------------------------------------------------------------


def upsert(
    conn: psycopg.Connection[Any], network_id: UUID, kind: str, label: str, cat: str | None
) -> UUID:
    row = conn.execute(
        "select upsert_tag(%s, %s::tag_kind, %s, %s::skill_category)",
        (network_id, kind, label, cat),
    ).fetchone()
    assert row is not None
    return row[0]


def test_upsert_tag_keeps_the_original_category_on_a_match(
    network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    first = upsert(conn, network.network_id, "skill", "Cooking", "crafts_trades")
    again = upsert(conn, network.network_id, "skill", " cooking", "culture")

    assert first == again
    assert conn.execute("select category from tag where id = %s", (first,)).fetchone() == (
        "crafts_trades",
    )


def test_upsert_tag_keeps_kinds_and_networks_apart(
    network: NetworkFixture, other_network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    skill = upsert(conn, network.network_id, "skill", "Banking", "business")
    industry = upsert(conn, network.network_id, "industry", "Banking", None)
    elsewhere = upsert(conn, other_network.network_id, "skill", "Banking", "business")

    assert len({skill, industry, elsewhere}) == 3


def test_upsert_tag_follows_an_alias_chain(
    network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    target = upsert(conn, network.network_id, "industry", "Healthcare", None)
    middle = conn.execute(
        "insert into tag (network_id, kind, label, alias_of_tag_id)"
        " values (%s, 'industry', 'Health', %s) returning id",
        (network.network_id, target),
    ).fetchone()[0]  # type: ignore[index]
    conn.execute(
        "insert into tag (network_id, kind, label, alias_of_tag_id)"
        " values (%s, 'industry', 'Med', %s)",
        (network.network_id, middle),
    )

    assert upsert(conn, network.network_id, "industry", "med", None) == target


def test_upsert_tag_enforces_category_rules_through_the_schema(
    network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    with pytest.raises(psycopg.errors.CheckViolation):
        upsert(conn, network.network_id, "skill", "No category", None)
    with pytest.raises(psycopg.errors.CheckViolation):
        upsert(conn, network.network_id, "industry", "With category", "other")


# -- possible duplicates ------------------------------------------------------------------------


def with_contact(
    conn: psycopg.Connection[Any], network: NetworkFixture, person: UUID, kind: str, value: str
) -> None:
    conn.execute(
        "insert into contact_value (network_id, person_id, kind, value) values (%s, %s, %s, %s)",
        (network.network_id, person, kind, value),
    )


def test_possible_duplicates_on_phone(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    existing = make_person(conn, network.network_id, name_ar="أحمد", name_latin="Ahmed")
    with_contact(conn, network, existing, "phone", "01012345678")

    body = create(client, network, contacts=[{"kind": "phone", "value": "+20 10 1234 5678"}])

    assert body["possible_duplicates"] == [
        {"person_id": str(existing), "display_name": "أحمد", "matched_on": "phone"}
    ]


def test_possible_duplicates_match_across_phone_and_whatsapp(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    existing = make_person(conn, network.network_id, name_latin="Whats App")
    with_contact(conn, network, existing, "whatsapp", "00201012345678")

    body = create(client, network, contacts=[{"kind": "phone", "value": "010 1234 5678"}])

    assert [(d["person_id"], d["matched_on"]) for d in body["possible_duplicates"]] == [
        (str(existing), "phone")
    ]


def test_possible_duplicates_on_email_and_social_link(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    by_email = make_person(conn, network.network_id, name_latin="Email Twin")
    with_contact(conn, network, by_email, "email", "Twin@Example.com")
    by_link = make_person(conn, network.network_id, name_latin="Link Twin")
    conn.execute(
        "insert into social_link (network_id, person_id, kind, url)"
        " values (%s, %s, 'linkedin', %s)",
        (network.network_id, by_link, "https://www.linkedin.com/in/twin/"),
    )

    body = create(
        client,
        network,
        contacts=[{"kind": "email", "value": " twin@example.com "}],
        social_links=[{"kind": "linkedin", "url": "http://linkedin.com/in/twin?utm=1"}],
    )

    assert {(d["person_id"], d["matched_on"]) for d in body["possible_duplicates"]} == {
        (str(by_email), "email"),
        (str(by_link), "social_link"),
    }


def test_possible_duplicates_ignore_the_person_just_created_and_other_networks(
    client: TestClient,
    network: NetworkFixture,
    other_network: NetworkFixture,
    conn: psycopg.Connection[Any],
) -> None:
    foreign = make_person(conn, other_network.network_id, name_latin="Foreign")
    with_contact(conn, other_network, foreign, "phone", "01012345678")
    near_miss = make_person(conn, network.network_id, name_latin="Near Miss")
    with_contact(conn, network, near_miss, "phone", "01012345679")

    body = create(client, network, contacts=[{"kind": "phone", "value": "01012345678"}])

    assert body["possible_duplicates"] == []  # itself, the other network and a near miss: none


def test_create_never_blocks_on_a_duplicate(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    for _ in range(2):
        body = create(client, network, contacts=[{"kind": "phone", "value": "01012345678"}])
    assert len(body["possible_duplicates"]) == 1
    assert (
        count(conn, "select count(*) from contact_value where network_id = %s", network.network_id)
        == 2
    )


# -- edit, confirm, delete ----------------------------------------------------------------------


def test_edit_resets_last_confirmed(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    created = create(client, network)["person"]
    conn.execute(
        "update person set last_confirmed_at = now() - interval '2 years' where id = %s",
        (created["id"],),
    )
    assert client.get(f"/api/v1/people/{created['id']}").json()["is_stale"] is True

    response = client.put(f"/api/v1/people/{created['id']}", json=person_body(headline="Edited"))

    assert response.status_code == 200
    assert response.json()["headline"] == "Edited"
    assert response.json()["is_stale"] is False
    assert (
        count(
            conn,
            "select count(*) from person"
            " where id = %s and last_confirmed_at > now() - interval '1 minute'",
            created["id"],
        )
        == 1
    )


def test_edit_replaces_skills_industries_links_and_contacts(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    created = create(
        client,
        network,
        name_ar="سمير",
        skills=[{"label": "Go", "category": "technical"}, {"label": "Chess", "category": "sports"}],
        industries=["Retail"],
        social_links=[{"kind": "x", "url": "https://x.com/a"}],
        contacts=[{"kind": "phone", "value": "01012345678"}],
    )["person"]

    response = client.put(
        f"/api/v1/people/{created['id']}",
        json=person_body(
            name_ar=None,
            skills=[{"label": "go", "category": "technical", "level": "basic"}],
            industries=[],
            social_links=[{"kind": "github", "url": "https://github.com/a"}],
            contacts=[{"kind": "email", "value": "a@example.com"}],
        ),
    )

    assert response.status_code == 200
    edited = response.json()
    assert edited["name_ar"] is None
    assert [(s["label"], s["level"]) for s in edited["skills"]] == [("Go", "basic")]
    assert edited["industries"] == []
    assert [link["kind"] for link in edited["social_links"]] == ["github"]
    assert [(c["kind"], c["value"]) for c in edited["contacts"]] == [("email", "a@example.com")]
    # Connections are untouched by an edit.
    assert edited["connections"] == created["connections"]


def test_edit_keeps_who_entered_an_unchanged_contact(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    contributor = make_person(conn, network.network_id, name_latin="Contributor")
    created = create(client, network)["person"]
    contact_id = conn.execute(
        "insert into contact_value (network_id, person_id, kind, value, added_by_person_id)"
        " values (%s, %s, 'phone', '01012345678', %s) returning id",
        (network.network_id, created["id"], contributor),
    ).fetchone()[0]  # type: ignore[index]

    response = client.put(
        f"/api/v1/people/{created['id']}",
        json=person_body(
            contacts=[
                {"kind": "phone", "value": "01012345678"},
                {"kind": "email", "value": "new@example.com"},
            ]
        ),
    )

    by_kind = {c["kind"]: c for c in response.json()["contacts"]}
    assert by_kind["phone"]["id"] == str(contact_id)
    assert by_kind["phone"]["added_by_person_id"] == str(contributor)
    assert by_kind["email"]["added_by_person_id"] == str(network.admin_person_id)


def test_edit_requires_a_name_and_an_existing_person(
    client: TestClient, network: NetworkFixture, other_network: NetworkFixture
) -> None:
    created = create(client, network)["person"]

    assert client.put(f"/api/v1/people/{created['id']}", json={"headline": "x"}).status_code == 422
    assert client.put(f"/api/v1/people/{uuid4()}", json=person_body()).status_code == 404
    foreign = other_network.admin_person_id
    assert client.put(f"/api/v1/people/{foreign}", json=person_body()).status_code == 404


def test_confirm_sets_last_confirmed(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    created = create(client, network, headline="Kept")["person"]
    conn.execute(
        "update person set last_confirmed_at = now() - interval '13 months' where id = %s",
        (created["id"],),
    )

    response = client.post(f"/api/v1/people/{created['id']}/confirm")

    assert response.status_code == 200
    assert response.json()["is_stale"] is False
    assert response.json()["headline"] == "Kept"
    assert client.post(f"/api/v1/people/{uuid4()}/confirm").status_code == 404


def test_stale_means_older_than_twelve_months(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    created = create(client, network)["person"]
    for age, stale in (("11 months", False), ("13 months", True)):
        conn.execute(
            "update person set last_confirmed_at = now() - %s::interval where id = %s",
            (age, created["id"]),
        )
        assert client.get(f"/api/v1/people/{created['id']}").json()["is_stale"] is stale


def test_delete_cascades(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    created = create(
        client,
        network,
        skills=[{"label": "Go", "category": "technical"}],
        industries=["Retail"],
        social_links=[{"kind": "x", "url": "https://x.com/a"}],
        contacts=[{"kind": "phone", "value": "01012345678"}],
    )["person"]
    pid = created["id"]

    response = client.delete(f"/api/v1/people/{pid}")

    assert response.status_code == 204
    assert response.content == b""
    for table in ("contact_value", "person_skill", "person_industry", "social_link"):
        assert count(conn, f"select count(*) from {table} where person_id = %s", pid) == 0
    assert count(conn, "select count(*) from connection where %s in (person_a, person_b)", pid) == 0
    assert count(conn, "select count(*) from person where id = %s", pid) == 0
    # Only that person went: the admin, and the tags other people may use, remain.
    assert count(conn, "select count(*) from person where id = %s", network.admin_person_id) == 1
    assert client.get(f"/api/v1/people/{pid}").status_code == 404
    assert client.delete(f"/api/v1/people/{pid}").status_code == 404


def test_cannot_delete_self(client: TestClient, network: NetworkFixture) -> None:
    response = client.delete(f"/api/v1/people/{network.admin_person_id}")

    assert response.status_code == 409
    assert response.json()["code"] == "cannot_delete_self"
    assert client.get(f"/api/v1/people/{network.admin_person_id}").status_code == 200


def test_get_unknown_or_foreign_person_is_404(
    client: TestClient, network: NetworkFixture, other_network: NetworkFixture
) -> None:
    assert client.get(f"/api/v1/people/{uuid4()}").status_code == 404
    assert client.get(f"/api/v1/people/{other_network.admin_person_id}").status_code == 404
    assert client.delete(f"/api/v1/people/{other_network.admin_person_id}").status_code == 404


def test_every_endpoint_requires_an_admin_token(network: NetworkFixture) -> None:
    anonymous = TestClient(create_app())
    pid = network.admin_person_id
    member = TestClient(
        create_app(),
        headers={
            "Authorization": "Bearer "
            + token_for({**network.admin_claims, "member_role": "member"})
        },
    )
    no_mfa = TestClient(
        create_app(),
        headers={"Authorization": "Bearer " + token_for({**network.admin_claims, "aal": "aal1"})},
    )
    calls = [
        ("post", "/api/v1/people"),
        ("get", f"/api/v1/people/{pid}"),
        ("put", f"/api/v1/people/{pid}"),
        ("post", f"/api/v1/people/{pid}/confirm"),
        ("delete", f"/api/v1/people/{pid}"),
        ("post", "/api/v1/connections"),
        ("patch", f"/api/v1/connections/{pid}"),
        ("delete", f"/api/v1/connections/{pid}"),
        ("get", "/api/v1/tags?kind=skill"),
    ]
    for method, path in calls:
        assert getattr(anonymous, method)(path).status_code == 401, (method, path)
        assert getattr(member, method)(path).status_code == 403, (method, path)
        assert getattr(no_mfa, method)(path).status_code == 403, (method, path)


# -- connections --------------------------------------------------------------------------------


def test_create_connection_orders_the_pair_and_rejects_a_second(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    a = make_person(conn, network.network_id, name_latin="A")
    b = make_person(conn, network.network_id, name_latin="B")

    for first, second in ((a, b), (b, a)):  # whichever way round the caller sends the pair
        conn.execute("delete from connection where %s in (person_a, person_b)", (a,))
        response = client.post(
            "/api/v1/connections",
            json={
                "person_a": str(first),
                "person_b": str(second),
                "strength": "strong",
                "note": "n",
            },
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert {body["person_a"], body["person_b"]} == {str(a), str(b)}
        assert body["person_a"] < body["person_b"]
        assert body["strength"] == "strong"
        assert body["created_by_person_id"] == str(network.admin_person_id)

        again = client.post(
            "/api/v1/connections",
            json={"person_a": str(second), "person_b": str(first), "strength": "weak"},
        )
        assert again.status_code == 409
        assert again.json()["code"] == "conflict"


def test_create_connection_validates_its_ends(
    client: TestClient,
    network: NetworkFixture,
    other_network: NetworkFixture,
    conn: psycopg.Connection[Any],
) -> None:
    a = make_person(conn, network.network_id, name_latin="A")

    def post(**body: object) -> Response:
        return client.post("/api/v1/connections", json={"strength": "normal", **body})

    assert post(person_a=str(a), person_b=str(a)).status_code == 422  # a self-loop
    assert post(person_a=str(a), person_b=str(uuid4())).status_code == 422
    assert post(person_a=str(a), person_b=str(other_network.admin_person_id)).status_code == 422
    assert (
        post(person_a=str(a), person_b=str(network.admin_person_id), strength="x").status_code
        == 422
    )


def test_patch_connection_changes_strength_and_note(
    client: TestClient, network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    created = create(client, network, strength="weak", note="old")["person"]
    connection_id = created["connections"][0]["id"]

    changed = client.patch(f"/api/v1/connections/{connection_id}", json={"strength": "strong"})
    assert changed.status_code == 200
    assert (changed.json()["strength"], changed.json()["note"]) == ("strong", "old")

    renoted = client.patch(f"/api/v1/connections/{connection_id}", json={"note": "new"})
    assert (renoted.json()["strength"], renoted.json()["note"]) == ("strong", "new")

    cleared = client.patch(f"/api/v1/connections/{connection_id}", json={"note": None})
    assert (cleared.json()["strength"], cleared.json()["note"]) == ("strong", None)

    assert (
        client.patch(f"/api/v1/connections/{connection_id}", json={"strength": None}).status_code
        == 422
    )
    assert (
        client.patch(f"/api/v1/connections/{connection_id}", json={"strength": "x"}).status_code
        == 422
    )
    assert (
        client.patch(f"/api/v1/connections/{uuid4()}", json={"strength": "weak"}).status_code == 404
    )


def test_delete_connection(client: TestClient, network: NetworkFixture) -> None:
    created = create(client, network)["person"]
    connection_id = created["connections"][0]["id"]

    assert client.delete(f"/api/v1/connections/{connection_id}").status_code == 204
    assert client.get(f"/api/v1/people/{created['id']}").json()["connections"] == []
    assert client.delete(f"/api/v1/connections/{connection_id}").status_code == 404


# -- fix round 1: PUT is atomic, duplicate contact rows ------------------------------------------


@pytest.mark.parametrize("failing_step", ["_write_tags_and_links", "_sync_contacts"])
def test_edit_failing_midway_leaves_the_person_unchanged(
    network: NetworkFixture,
    conn: psycopg.Connection[Any],
    monkeypatch: pytest.MonkeyPatch,
    failing_step: str,
) -> None:
    from connections_api.modules.people import service

    client = TestClient(
        create_app(),
        headers={"Authorization": f"Bearer {token_for(network.admin_claims)}"},
        raise_server_exceptions=False,
    )
    created = create(
        client,
        network,
        headline="Before",
        skills=[{"label": "Go", "category": "technical"}],
        industries=["Retail"],
        social_links=[{"kind": "x", "url": "https://x.com/a"}],
        contacts=[{"kind": "phone", "value": "01012345678"}],
    )["person"]
    pid = created["id"]
    conn.execute(
        "update person set last_confirmed_at = now() - interval '2 years' where id = %s", (pid,)
    )
    before = client.get(f"/api/v1/people/{pid}").json()
    assert before["is_stale"] is True

    def boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr(service, failing_step, boom)
    response = client.put(
        f"/api/v1/people/{pid}",
        json=person_body(
            headline="After",
            skills=[{"label": "Rust", "category": "technical"}],
            industries=["Banking"],
            social_links=[{"kind": "github", "url": "https://github.com/a"}],
            contacts=[{"kind": "email", "value": "a@example.com"}],
        ),
    )

    assert response.status_code == 500
    monkeypatch.undo()
    assert client.get(f"/api/v1/people/{pid}").json() == before  # incl. skills, links, contacts,
    # last_confirmed_at and is_stale: the deletes and the profile update were rolled back.


@pytest.mark.parametrize("still_sent", [True, False])
def test_edit_removes_every_duplicate_row_of_a_contact_value(
    client: TestClient,
    network: NetworkFixture,
    conn: psycopg.Connection[Any],
    still_sent: bool,
) -> None:
    contributor = make_person(conn, network.network_id, name_latin="Contributor")
    created = create(client, network, contacts=[{"kind": "phone", "value": "01012345678"}])[
        "person"
    ]
    pid = created["id"]
    # The admin entered the number; a contributor later added the very same value (no uniqueness).
    conn.execute(
        "insert into contact_value (network_id, person_id, kind, value, added_by_person_id)"
        " values (%s, %s, 'phone', '01012345678', %s)",
        (network.network_id, pid, contributor),
    )
    assert count(conn, "select count(*) from contact_value where person_id = %s", pid) == 2

    contacts = [{"kind": "phone", "value": "01012345678"}] if still_sent else []
    response = client.put(f"/api/v1/people/{pid}", json=person_body(contacts=contacts))

    assert response.status_code == 200
    assert len(response.json()["contacts"]) == len(contacts)
    assert count(conn, "select count(*) from contact_value where person_id = %s", pid) == len(
        contacts
    )
