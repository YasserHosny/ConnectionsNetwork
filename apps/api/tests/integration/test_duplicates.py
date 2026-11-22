"""Duplicate review and merge over HTTP, against a real database under RLS (spec 8.4).

Graphs and contact rows are built as the superuser (outside RLS); requests carry a real admin
token, so they pass through current_admin and admin_tx as in production.

Skipped unless TEST_DATABASE_URL is set (CI always sets it).
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import psycopg
import pytest
from fastapi.testclient import TestClient
from httpx import Response
from integration.helpers import (
    NetworkFixture,
    drop_network,
    make_member,
    make_network,
    make_person,
    token_for,
)
from psycopg import errors

from connections_api import db
from connections_api.main import create_app

DSN = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL is not set")


@pytest.fixture
def conn() -> Iterator[psycopg.Connection[Any]]:
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


# -- fixtures written outside RLS ---------------------------------------------------------------


def person(
    conn: psycopg.Connection[Any], network: NetworkFixture, name: str, **columns: object
) -> UUID:
    """A person; `columns` are further person columns (profession, city, available_for...)."""
    pid = make_person(conn, network.network_id, name_latin=name)
    for column, value in columns.items():
        conn.execute(f"update person set {column} = %s where id = %s", (value, pid))  # noqa: S608
    return pid


def contact(
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    person_id: UUID,
    kind: str,
    value: str,
    added_by: UUID | None = None,
) -> None:
    conn.execute(
        "insert into contact_value (network_id, person_id, kind, value, added_by_person_id)"
        " values (%s, %s, %s::contact_kind, %s, %s)",
        (network.network_id, person_id, kind, value, added_by),
    )


def social(
    conn: psycopg.Connection[Any], network: NetworkFixture, person_id: UUID, kind: str, url: str
) -> None:
    conn.execute(
        "insert into social_link (network_id, person_id, kind, url)"
        " values (%s, %s, %s::social_link_kind, %s)",
        (network.network_id, person_id, kind, url),
    )


def link(
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    a: UUID,
    b: UUID,
    strength: str,
    *,
    created_by: UUID | None = None,
    note: str | None = None,
) -> None:
    one, other = sorted((a, b))
    conn.execute(
        "insert into connection (network_id, person_a, person_b, strength, created_by_person_id,"
        " note) values (%s, %s, %s, %s::connection_strength, %s, %s)",
        (network.network_id, one, other, strength, created_by, note),
    )


def skill(
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    person_id: UUID,
    label: str,
    level: str | None,
) -> None:
    tag_id = conn.execute(
        "select upsert_tag(%s, 'skill'::tag_kind, %s, 'technical'::skill_category)",
        (network.network_id, label),
    ).fetchone()
    assert tag_id is not None
    conn.execute(
        "insert into person_skill (network_id, person_id, tag_id, level)"
        " values (%s, %s, %s, %s::skill_level)",
        (network.network_id, person_id, tag_id[0], level),
    )


def industry(
    conn: psycopg.Connection[Any], network: NetworkFixture, person_id: UUID, label: str
) -> None:
    tag_id = conn.execute(
        "select upsert_tag(%s, 'industry'::tag_kind, %s, null)", (network.network_id, label)
    ).fetchone()
    assert tag_id is not None
    conn.execute(
        "insert into person_industry (network_id, person_id, tag_id) values (%s, %s, %s)",
        (network.network_id, person_id, tag_id[0]),
    )


def dismiss(conn: psycopg.Connection[Any], network: NetworkFixture, a: UUID, b: UUID) -> None:
    one, other = sorted((a, b))
    conn.execute(
        "insert into duplicate_dismissal (network_id, person_a, person_b) values (%s, %s, %s)",
        (network.network_id, one, other),
    )


def rows(conn: psycopg.Connection[Any], sql: str, *params: object) -> list[tuple[Any, ...]]:
    return conn.execute(sql, params).fetchall()  # type: ignore[arg-type]


def merge(client: TestClient, keep: UUID, drop: UUID) -> Response:
    return client.post("/api/v1/duplicates/merge", json={"keep": str(keep), "drop": str(drop)})


def pairs(client: TestClient) -> list[dict[str, Any]]:
    response = client.get("/api/v1/duplicates")
    assert response.status_code == 200, response.text
    return response.json()


def pair_ids(found: list[dict[str, Any]]) -> list[frozenset[str]]:
    return [frozenset((p["a"]["person_id"], p["b"]["person_id"])) for p in found]


def ids(*people: UUID) -> frozenset[str]:
    return frozenset(str(p) for p in people)


# -- the pair list ------------------------------------------------------------------------------


def test_pairs_from_phone_and_linkedin(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    sara = person(conn, network, "Sara", profession="Designer", city="Cairo")
    sarah = person(conn, network, "Sarah")
    omar = person(conn, network, "Omar")
    omer = person(conn, network, "Omer")
    # The same number, typed three ways: one pair.
    contact(conn, network, sara, "phone", "010 1234 5678")
    contact(conn, network, sarah, "phone", "+20 10 1234 5678")
    # The same LinkedIn profile, with and without www / trailing slash / tracking.
    social(conn, network, omar, "linkedin", "https://www.linkedin.com/in/omar-x/")
    social(conn, network, omer, "linkedin", "http://linkedin.com/in/omar-x")

    found = pairs(client)

    assert set(pair_ids(found)) == {ids(sara, sarah), ids(omar, omer)}
    assert len(found) == 2
    by_pair = {frozenset((p["a"]["person_id"], p["b"]["person_id"])): p for p in found}
    assert by_pair[ids(sara, sarah)]["matched_on"] == ["phone"]
    assert by_pair[ids(omar, omer)]["matched_on"] == ["social_link"]
    summary = {p["person_id"]: p for entry in found for p in (entry["a"], entry["b"])}
    assert summary[str(sara)] == {
        "person_id": str(sara),
        "display_name": "Sara",
        "profession": "Designer",
        "city": "Cairo",
    }
    assert summary[str(sarah)]["profession"] is None


def test_pair_lists_every_reason_once_and_is_ordered_a_before_b(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    x = person(conn, network, "X")
    y = person(conn, network, "Y")
    contact(conn, network, x, "phone", "01012345678")
    contact(conn, network, y, "whatsapp", "+201012345678")  # phone and WhatsApp share a number
    contact(conn, network, x, "email", "Same@Example.com")
    contact(conn, network, y, "email", "same@example.com")
    contact(conn, network, y, "email", "SAME@example.com")  # a repeat must not repeat the reason
    social(conn, network, x, "github", "https://github.com/same")
    social(conn, network, y, "github", "https://github.com/same/")

    found = pairs(client)

    assert len(found) == 1
    assert found[0]["matched_on"] == ["email", "phone", "social_link"]
    first, second = sorted((str(x), str(y)))
    assert (found[0]["a"]["person_id"], found[0]["b"]["person_id"]) == (first, second)


def test_pair_of_one_person_with_repeated_values_is_not_a_pair(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    solo = person(conn, network, "Solo")
    contact(conn, network, solo, "phone", "01012345678")
    contact(conn, network, solo, "whatsapp", "01012345678")
    social(conn, network, solo, "x", "https://x.com/solo")
    social(conn, network, solo, "website", "https://x.com/solo")

    assert pairs(client) == []


def test_pairs_ignore_other_networks_and_different_values(
    client: TestClient,
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    other_network: NetworkFixture,
) -> None:
    mine = person(conn, network, "Mine")
    stranger = person(conn, other_network, "Stranger")
    near = person(conn, network, "Near")
    contact(conn, network, mine, "phone", "01012345678")
    contact(conn, other_network, stranger, "phone", "01012345678")
    contact(conn, network, near, "phone", "01012345679")

    assert pairs(client) == []


def test_pairs_are_ordered_by_display_name(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    for first, second, number in (
        ("Zed", "Zoe", "01000000001"),
        ("Adam", "Adel", "01000000002"),
        ("Mona", "Mina", "01000000003"),
    ):
        contact(conn, network, person(conn, network, first), "phone", number)
        contact(conn, network, person(conn, network, second), "phone", number)

    found = pairs(client)

    assert [p["a"]["display_name"] for p in found] == sorted(p["a"]["display_name"] for p in found)
    assert found[0]["a"]["display_name"] in {"Adam", "Adel"}


def test_dismissed_pair_hidden(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    a = person(conn, network, "A")
    b = person(conn, network, "B")
    c = person(conn, network, "C")
    for p in (a, b, c):
        contact(conn, network, p, "email", "shared@example.com")
    assert len(pairs(client)) == 3

    # Either way round: the pair is the same pair.
    first = client.post("/api/v1/duplicates/dismiss", json={"a": str(b), "b": str(a)})
    assert first.status_code == 204, first.text
    again = client.post("/api/v1/duplicates/dismiss", json={"a": str(a), "b": str(b)})
    assert again.status_code == 204, again.text  # dismissing twice is fine

    assert set(pair_ids(pairs(client))) == {ids(a, c), ids(b, c)}
    assert rows(
        conn, "select count(*) from duplicate_dismissal where network_id = %s", network.network_id
    ) == [(1,)]


def test_dismiss_rejects_the_same_person_and_unknown_people(
    client: TestClient,
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    other_network: NetworkFixture,
) -> None:
    a = person(conn, network, "A")
    stranger = person(conn, other_network, "Stranger")
    unknown = "00000000-0000-4000-8000-000000000000"

    same = client.post("/api/v1/duplicates/dismiss", json={"a": str(a), "b": str(a)})
    missing = client.post("/api/v1/duplicates/dismiss", json={"a": str(a), "b": unknown})
    foreign = client.post("/api/v1/duplicates/dismiss", json={"a": str(a), "b": str(stranger)})

    assert same.status_code == 422
    assert missing.status_code == 422
    assert missing.json()["details"] == {"field": "b", "reason": "person_not_found"}
    assert foreign.status_code == 422
    assert rows(
        conn, "select count(*) from duplicate_dismissal where network_id = %s", network.network_id
    ) == [(0,)]


def test_duplicates_require_the_admin(
    network: NetworkFixture, conn: psycopg.Connection[Any]
) -> None:
    member = make_member(conn, network)
    anonymous = TestClient(create_app())
    as_member = TestClient(create_app(), headers={"Authorization": f"Bearer {token_for(member)}"})
    a, b = str(network.admin_person_id), str(make_person(conn, network.network_id))

    assert anonymous.get("/api/v1/duplicates").status_code == 401
    assert as_member.get("/api/v1/duplicates").status_code == 403
    assert as_member.post("/api/v1/duplicates/dismiss", json={"a": a, "b": b}).status_code == 403
    assert (
        as_member.post("/api/v1/duplicates/merge", json={"keep": a, "drop": b}).status_code == 403
    )


# -- merge --------------------------------------------------------------------------------------


def test_merge_moves_everything(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    helper_x = person(conn, network, "Helper X")
    helper_y = person(conn, network, "Helper Y")
    keep = person(conn, network, "Keep")
    drop = person(conn, network, "Drop")
    contact(conn, network, keep, "phone", "01012345678", added_by=helper_x)
    contact(conn, network, drop, "phone", "+20 10 1234 5678", added_by=helper_x)  # repeat: goes
    contact(conn, network, drop, "phone", "0100 000 0000", added_by=helper_y)
    contact(conn, network, drop, "email", "drop@example.com", added_by=helper_y)
    # The same number from somebody else is a different provenance: both rows stay.
    contact(conn, network, drop, "whatsapp", "01012345678", added_by=helper_y)
    # The drop person entered one themselves: it becomes the kept person's own.
    contact(conn, network, drop, "email", "self@example.com", added_by=drop)
    social(conn, network, keep, "linkedin", "https://linkedin.com/in/same")
    social(conn, network, drop, "linkedin", "https://www.linkedin.com/in/same/")  # repeat: goes
    social(conn, network, drop, "github", "https://github.com/drop")
    skill(conn, network, drop, "Python", "good")
    industry(conn, network, keep, "Banking")
    industry(conn, network, drop, "Banking")
    industry(conn, network, drop, "Telecom")

    response = merge(client, keep, drop)

    assert response.status_code == 200, response.text
    out = response.json()
    assert out["id"] == str(keep)
    assert rows(conn, "select count(*) from person where id = %s", drop) == [(0,)]
    contacts = {(c["kind"], c["added_by_person_id"]) for c in out["contacts"]}
    assert contacts == {
        ("phone", str(helper_x)),
        ("phone", str(helper_y)),
        ("email", str(helper_y)),
        ("whatsapp", str(helper_y)),
        ("email", str(keep)),
    }
    assert len(out["contacts"]) == 5
    assert sorted(s["kind"] for s in out["social_links"]) == ["github", "linkedin"]
    assert [s["label"] for s in out["skills"]] == ["Python"]
    assert sorted(i["label"] for i in out["industries"]) == ["Banking", "Telecom"]
    # Nothing of the dropped person is left behind anywhere.
    for table in ("contact_value", "social_link", "person_skill", "person_industry"):
        assert rows(conn, f"select count(*) from {table} where person_id = %s", drop) == [(0,)]  # noqa: S608
    assert rows(conn, "select count(*) from contact_value where added_by_person_id = %s", drop) == [
        (0,)
    ]


def test_merge_connected_pair_no_self_loop(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    keep = person(conn, network, "Keep")
    drop = person(conn, network, "Drop")
    other = person(conn, network, "Other")
    link(conn, network, keep, drop, "strong")
    link(conn, network, drop, other, "normal")

    response = merge(client, keep, drop)

    assert response.status_code == 200, response.text
    edges = rows(
        conn,
        "select person_a, person_b, strength from connection where %s in (person_a, person_b)",
        keep,
    )
    assert len(edges) == 1
    assert set(edges[0][:2]) == {keep, other}
    assert edges[0][0] < edges[0][1]
    assert edges[0][2] == "normal"
    assert rows(conn, "select count(*) from connection where person_a = person_b") == [(0,)]
    assert [c["person_id"] for c in response.json()["connections"]] == [str(other)]


@pytest.mark.parametrize(
    ("keep_strength", "drop_strength", "expected"),
    [
        ("weak", "strong", "strong"),
        ("strong", "weak", "strong"),
        ("normal", "weak", "normal"),
        ("weak", "normal", "normal"),
        ("normal", "normal", "normal"),
    ],
)
def test_merge_shared_neighbor_keeps_stronger(
    client: TestClient,
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    keep_strength: str,
    drop_strength: str,
    expected: str,
) -> None:
    keep = person(conn, network, "Keep")
    drop = person(conn, network, "Drop")
    shared = person(conn, network, "Shared")
    link(conn, network, keep, shared, keep_strength)
    link(conn, network, drop, shared, drop_strength)

    response = merge(client, keep, drop)

    assert response.status_code == 200, response.text
    edges = rows(
        conn,
        "select strength from connection where %s in (person_a, person_b)"
        " and %s in (person_a, person_b)",
        keep,
        shared,
    )
    assert edges == [(expected,)]
    assert rows(conn, "select count(*) from connection where %s in (person_a, person_b)", drop) == [
        (0,)
    ]


def test_merge_moves_connections_whichever_way_the_ids_sort(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    keep = person(conn, network, "Keep")
    drop = person(conn, network, "Drop")
    others = [person(conn, network, f"N{i}") for i in range(6)]
    for n in others:
        link(conn, network, drop, n, "weak", created_by=drop)

    response = merge(client, keep, drop)

    assert response.status_code == 200, response.text
    edges = rows(
        conn,
        "select person_a, person_b, created_by_person_id from connection"
        " where %s in (person_a, person_b)",
        keep,
    )
    assert len(edges) == 6
    assert all(a < b for a, b, _ in edges)
    assert {(b if a == keep else a) for a, b, _ in edges} == set(others)
    assert {c for _, _, c in edges} == {keep}  # the drop person's authorship moves with them


def test_merge_shared_neighbor_keeps_the_note_it_has(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    keep = person(conn, network, "Keep")
    drop = person(conn, network, "Drop")
    n1 = person(conn, network, "N1")
    n2 = person(conn, network, "N2")
    link(conn, network, keep, n1, "weak", note="keep note")
    link(conn, network, drop, n1, "strong", note="drop note")
    link(conn, network, keep, n2, "weak")
    link(conn, network, drop, n2, "weak", note="only drop has one")

    assert merge(client, keep, drop).status_code == 200

    notes = dict(
        rows(
            conn,
            "select case when person_a = %s then person_b else person_a end, note"
            " from connection where %s in (person_a, person_b)",
            keep,
            keep,
        )
    )
    assert notes == {n1: "keep note", n2: "only drop has one"}


def test_merge_skill_keeps_higher_level(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    keep = person(conn, network, "Keep")
    drop = person(conn, network, "Drop")
    skill(conn, network, keep, "Python", "basic")
    skill(conn, network, drop, "Python", "expert")
    skill(conn, network, keep, "Go", "expert")
    skill(conn, network, drop, "Go", "basic")
    skill(conn, network, keep, "Rust", None)
    skill(conn, network, drop, "Rust", "good")
    skill(conn, network, keep, "Zig", "good")
    skill(conn, network, drop, "Zig", None)
    skill(conn, network, drop, "Lua", None)

    response = merge(client, keep, drop)

    assert response.status_code == 200, response.text
    levels = {s["label"]: s["level"] for s in response.json()["skills"]}
    assert levels == {
        "Python": "expert",
        "Go": "expert",
        "Rust": "good",
        "Zig": "good",
        "Lua": None,
    }


def test_merge_fills_empty_fields_and_keeps_the_ones_it_has(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    old = datetime.now(UTC) - timedelta(days=800)
    recent = datetime.now(UTC) - timedelta(days=3)
    keep = make_person(conn, network.network_id, name_ar=None, name_latin="Keep Latin")
    drop = make_person(conn, network.network_id, name_ar="الاسم", name_latin="Drop Latin")
    conn.execute(
        "update person set profession = 'Keep profession', city = '  ', seniority = null,"
        " available_for = array['freelance', 'job_seeking'], last_confirmed_at = %s,"
        " admin_notes = null where id = %s",
        (old, keep),
    )
    conn.execute(
        "update person set profession = 'Drop profession', city = 'Giza', country = 'Egypt',"
        " seniority = 'manager', headline = 'Drop headline', organization = 'Drop Org',"
        " available_for = array['freelance', 'partner_seeking'], last_confirmed_at = %s,"
        " admin_notes = 'drop notes' where id = %s",
        (recent, drop),
    )

    response = merge(client, keep, drop)

    assert response.status_code == 200, response.text
    out = response.json()
    assert out["name_latin"] == "Keep Latin"  # non-empty keep value wins
    assert out["name_ar"] == "الاسم"  # empty keep value filled
    assert out["display_name"] == "الاسم"
    assert out["profession"] == "Keep profession"
    assert out["city"] == "Giza"  # blank counts as empty
    assert out["country"] == "Egypt"
    assert out["seniority"] == "manager"
    assert out["headline"] == "Drop headline"
    assert out["organization"] == "Drop Org"
    assert out["admin_notes"] == "drop notes"
    assert out["available_for"] == ["freelance", "job_seeking", "partner_seeking"]
    assert datetime.fromisoformat(out["last_confirmed_at"]) == recent
    assert out["is_stale"] is False


def test_merge_repoints_every_other_reference(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    keep = person(conn, network, "Keep")
    drop = person(conn, network, "Drop")
    created = person(conn, network, "Created by drop")
    n1 = person(conn, network, "N1")
    n2 = person(conn, network, "N2")
    conn.execute("update person set created_by_person_id = %s where id = %s", (drop, created))
    link(conn, network, created, n1, "normal", created_by=drop)
    link_row = conn.execute(
        "insert into contributor_link (network_id, person_id, token_hash)"
        " values (%s, %s, decode(repeat('ab', 32), 'hex')) returning id",
        (network.network_id, drop),
    ).fetchone()
    assert link_row is not None
    # Dismissals involving the drop person move to keep; a dismissal between the two vanishes,
    # and one that keep already has is not doubled.
    dismiss(conn, network, drop, n1)
    dismiss(conn, network, keep, n1)
    dismiss(conn, network, n2, drop)
    dismiss(conn, network, keep, drop)
    # A retry of the request that created drop answers with keep after the merge.
    conn.execute(
        "insert into idempotency_key (network_id, scope, key, person_id, payload_hash)"
        " values (%s, 'admin', 'created-drop', %s, repeat('0', 64))",
        (network.network_id, drop),
    )

    response = merge(client, keep, drop)

    assert response.status_code == 200, response.text
    assert rows(conn, "select created_by_person_id from person where id = %s", created) == [(keep,)]
    assert rows(
        conn,
        "select created_by_person_id from connection where person_a = %s or person_b = %s",
        n1,
        n1,
    ) == [(keep,)]
    assert rows(conn, "select person_id from contributor_link where id = %s", link_row[0]) == [
        (keep,)
    ]
    dismissals = rows(
        conn,
        "select person_a, person_b from duplicate_dismissal where network_id = %s",
        network.network_id,
    )
    assert {frozenset(d) for d in dismissals} == {frozenset((keep, n1)), frozenset((keep, n2))}
    assert len(dismissals) == 2
    assert all(a < b for a, b in dismissals)
    assert rows(
        conn, "select person_id from idempotency_key where network_id = %s", network.network_id
    ) == [(keep,)]


def test_merge_does_not_make_a_person_the_creator_of_themselves(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    keep = person(conn, network, "Keep")
    drop = person(conn, network, "Drop")
    conn.execute("update person set created_by_person_id = %s where id = %s", (drop, keep))

    assert merge(client, keep, drop).status_code == 200

    assert rows(conn, "select created_by_person_id from person where id = %s", keep) == [(None,)]


def test_merge_admin_self_allowed_as_keep_only(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    admin = network.admin_person_id
    duplicate_of_admin = person(conn, network, "Admin again")
    contact(conn, network, duplicate_of_admin, "email", "admin@example.com", added_by=admin)
    other = person(conn, network, "Other")
    contact(conn, network, other, "email", "other@example.com")

    refused = merge(client, other, admin)

    assert refused.status_code == 409
    assert refused.json()["code"] == "cannot_drop_account"
    assert rows(conn, "select count(*) from person where id = %s", admin) == [(1,)]

    allowed = merge(client, admin, duplicate_of_admin)

    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["id"] == str(admin)
    assert [c["value"] for c in allowed.json()["contacts"]] == ["admin@example.com"]


def test_merge_refuses_to_drop_any_account(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    member = UUID(make_member(conn, network)["person_id"])
    other = person(conn, network, "Other")
    contact(conn, network, member, "phone", "01012345678")

    response = merge(client, other, member)

    assert response.status_code == 409
    assert response.json()["code"] == "cannot_drop_account"
    # Nothing was merged: the member's data is where it was.
    assert rows(conn, "select count(*) from contact_value where person_id = %s", member) == [(1,)]
    assert rows(conn, "select count(*) from contact_value where person_id = %s", other) == [(0,)]


def test_merge_rejects_unknown_foreign_and_identical_people(
    client: TestClient,
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    other_network: NetworkFixture,
) -> None:
    mine = person(conn, network, "Mine")
    stranger = person(conn, other_network, "Stranger")
    contact(conn, other_network, stranger, "phone", "01012345678")
    unknown = UUID("00000000-0000-4000-8000-000000000000")

    same = merge(client, mine, mine)
    unknown_drop = merge(client, mine, unknown)
    unknown_keep = merge(client, unknown, mine)
    foreign_drop = merge(client, mine, stranger)
    foreign_keep = merge(client, stranger, mine)

    assert same.status_code == 422
    for response, field in (
        (unknown_drop, "drop"),
        (unknown_keep, "keep"),
        (foreign_drop, "drop"),
        (foreign_keep, "keep"),
    ):
        assert response.status_code == 422, response.text
        assert response.json()["details"] == {"field": field, "reason": "person_not_found"}
    assert rows(conn, "select count(*) from person where id = %s", stranger) == [(1,)]
    assert rows(conn, "select count(*) from person where id = %s", mine) == [(1,)]


def test_merge_function_refuses_anyone_but_the_admin(
    conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    member = make_member(conn, network)
    keep = person(conn, network, "Keep")
    drop = person(conn, network, "Drop")
    anon_claims: dict[str, str] = {}

    with pytest.raises(errors.InsufficientPrivilege), db.user_tx(member, DSN) as tx:
        tx.execute("select merge_persons(%s, %s)", (keep, drop))
    with pytest.raises(errors.InsufficientPrivilege), db.user_tx(anon_claims, DSN) as tx:
        tx.execute("select merge_persons(%s, %s)", (keep, drop))
    # An admin session without TOTP (aal1) is refused by the database itself, not only the API.
    aal1_admin = {**network.admin_claims, "aal": "aal1"}
    with pytest.raises(errors.InsufficientPrivilege), db.user_tx(aal1_admin, DSN) as tx:
        tx.execute("select merge_persons(%s, %s)", (keep, drop))
    assert rows(conn, "select count(*) from person where id = any(%s)", [keep, drop]) == [(2,)]


def test_merge_function_is_not_callable_with_another_networks_people(
    conn: psycopg.Connection[Any], network: NetworkFixture, other_network: NetworkFixture
) -> None:
    mine = person(conn, network, "Mine")
    stranger = person(conn, other_network, "Stranger")

    with pytest.raises(errors.NoDataFound), db.user_tx(network.admin_claims, DSN) as tx:
        tx.execute("select merge_persons(%s, %s)", (mine, stranger))
    with pytest.raises(errors.InvalidParameterValue), db.user_tx(network.admin_claims, DSN) as tx:
        tx.execute("select merge_persons(%s, %s)", (mine, mine))
    assert rows(conn, "select count(*) from person where id = any(%s)", [mine, stranger]) == [(2,)]


def test_merge_is_one_transaction(conn: psycopg.Connection[Any], network: NetworkFixture) -> None:
    """A merge that fails part-way leaves the data as it was (here: refused for an account)."""
    keep = person(conn, network, "Keep")
    member = UUID(make_member(conn, network)["person_id"])
    other = person(conn, network, "Other")
    link(conn, network, member, other, "strong")
    social(conn, network, member, "github", "https://github.com/member")

    with (
        pytest.raises(errors.ObjectNotInPrerequisiteState),
        db.user_tx(network.admin_claims, DSN) as tx,
    ):
        tx.execute("select merge_persons(%s, %s)", (keep, member))

    assert rows(
        conn, "select count(*) from connection where %s in (person_a, person_b)", member
    ) == [(1,)]
    assert rows(conn, "select count(*) from social_link where person_id = %s", member) == [(1,)]
