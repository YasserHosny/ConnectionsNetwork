"""Review lists (stale, unreachable) and the data export over HTTP, against a real database.

Rows are set up as the superuser (outside RLS); requests carry a real admin token, so they pass
through current_admin and admin_tx as in production.

Skipped unless TEST_DATABASE_URL is set (CI always sets it).
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import zipfile
from collections.abc import Iterator
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

import psycopg
import pytest
from fastapi.testclient import TestClient
from integration.helpers import (
    NetworkFixture,
    drop_network,
    make_member,
    make_network,
    make_person,
    token_for,
)

from connections_api import db
from connections_api.main import create_app

DSN = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL is not set")

TOKEN_HASH = bytes(range(32))


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


def person(
    conn: psycopg.Connection[Any], network: NetworkFixture, name: str, **columns: object
) -> UUID:
    person_id = make_person(conn, network.network_id, name_latin=name)
    for column, value in columns.items():
        conn.execute(
            f"update person set {column} = %s where id = %s",  # noqa: S608 - test-only columns
            (value, person_id),
        )
    return person_id


def months_ago(conn: psycopg.Connection[Any], months: int) -> datetime:
    row = conn.execute("select now() - make_interval(months => %s)", (months,)).fetchone()
    assert row is not None
    return row[0]


def link(
    conn: psycopg.Connection[Any], network: NetworkFixture, a: UUID, b: UUID, strength: str
) -> None:
    one, other = sorted((a, b))
    conn.execute(
        "insert into connection (network_id, person_a, person_b, strength)"
        " values (%s, %s, %s, %s::connection_strength)",
        (network.network_id, one, other, strength),
    )


# -- stale --------------------------------------------------------------------------------------


def test_stale_threshold_12_months(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    fresh = person(conn, network, "Eleven Months", last_confirmed_at=months_ago(conn, 11))
    stale = person(
        conn, network, "Thirteen Months", profession="Plumber", city="Cairo",
        last_confirmed_at=months_ago(conn, 13),
    )  # fmt: skip

    response = client.get("/api/v1/review/stale")

    assert response.status_code == 200, response.text
    listed = {item["person_id"]: item for item in response.json()}
    assert str(fresh) not in listed
    assert str(network.admin_person_id) not in listed
    assert set(listed) == {str(stale)}
    item = listed[str(stale)]
    assert item["display_name"] == "Thirteen Months"
    assert item["profession"] == "Plumber"
    assert item["city"] == "Cairo"
    assert datetime.fromisoformat(item["last_confirmed_at"]) < months_ago(conn, 12)


def test_stale_oldest_first_and_scoped_to_the_network(
    client: TestClient,
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    other_network: NetworkFixture,
) -> None:
    newer = person(conn, network, "Newer", last_confirmed_at=months_ago(conn, 14))
    oldest = person(conn, network, "Oldest", last_confirmed_at=months_ago(conn, 40))
    middle = person(conn, network, "Middle", last_confirmed_at=months_ago(conn, 20))
    person(conn, other_network, "Foreign", last_confirmed_at=months_ago(conn, 50))

    response = client.get("/api/v1/review/stale")

    assert [item["person_id"] for item in response.json()] == [
        str(oldest),
        str(middle),
        str(newer),
    ]


# -- unreachable --------------------------------------------------------------------------------


def test_unreachable_after_bridge_deleted(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    owner = network.admin_person_id
    a = person(conn, network, "A bridge")
    b = person(conn, network, "B behind")
    link(conn, network, owner, a, "strong")
    link(conn, network, a, b, "strong")
    assert client.get("/api/v1/review/unreachable").json() == []

    conn.execute("delete from person where id = %s", (a,))
    response = client.get("/api/v1/review/unreachable")

    assert response.status_code == 200, response.text
    assert [item["person_id"] for item in response.json()] == [str(b)]
    assert response.json()[0]["display_name"] == "B behind"
    still_there = conn.execute("select 1 from person where id = %s", (b,)).fetchone()
    assert still_there is not None


def test_unreachable_excludes_owner_orders_by_name_and_is_scoped(
    client: TestClient,
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    other_network: NetworkFixture,
) -> None:
    reachable = person(conn, network, "Reachable")
    link(conn, network, network.admin_person_id, reachable, "weak")
    person(conn, network, "Zed")
    person(conn, network, "alice")
    person(conn, network, "Bob")
    person(conn, other_network, "Foreign orphan")

    response = client.get("/api/v1/review/unreachable")

    assert [item["display_name"] for item in response.json()] == ["alice", "Bob", "Zed"]
    assert set(response.json()[0]) == {
        "person_id",
        "display_name",
        "profession",
        "city",
        "last_confirmed_at",
    }


def test_unreachable_when_owner_has_no_connections(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    only = person(conn, network, "Only")

    response = client.get("/api/v1/review/unreachable")

    assert [item["person_id"] for item in response.json()] == [str(only)]


# -- export -------------------------------------------------------------------------------------

NETWORK_TABLES = {
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
}


def fill_network(conn: psycopg.Connection[Any], network: NetworkFixture) -> dict[str, UUID]:
    """One row in every table except duplicate_dismissal (left empty on purpose)."""
    owner = network.admin_person_id
    friend = person(conn, network, "Friend", name_ar="صديق")
    skill_tag = conn.execute(
        "select upsert_tag(%s, 'skill'::tag_kind, 'Plumbing', 'crafts_trades'::skill_category)",
        (network.network_id,),
    ).fetchone()
    industry_tag = conn.execute(
        "select upsert_tag(%s, 'industry'::tag_kind, 'Construction', null)", (network.network_id,)
    ).fetchone()
    assert skill_tag and industry_tag
    conn.execute(
        "insert into person_skill (network_id, person_id, tag_id, level)"
        " values (%s, %s, %s, 'expert')",
        (network.network_id, friend, skill_tag[0]),
    )
    conn.execute(
        "insert into person_industry (network_id, person_id, tag_id) values (%s, %s, %s)",
        (network.network_id, friend, industry_tag[0]),
    )
    conn.execute(
        "insert into social_link (network_id, person_id, kind, url)"
        " values (%s, %s, 'linkedin', 'https://linkedin.com/in/friend')",
        (network.network_id, friend),
    )
    conn.execute(
        "insert into contact_value (network_id, person_id, kind, value, added_by_person_id)"
        " values (%s, %s, 'phone', '010 1234 5678', %s)",
        (network.network_id, friend, owner),
    )
    link(conn, network, owner, friend, "strong")
    conn.execute(
        "update person set available_for = array['freelance', 'job_seeking'] where id = %s",
        (friend,),
    )
    conn.execute(
        "insert into contributor_link (network_id, person_id, token_hash) values (%s, %s, %s)",
        (network.network_id, friend, TOKEN_HASH),
    )
    return {"friend": friend}


def test_export_json_contains_all_tables(
    client: TestClient,
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    other_network: NetworkFixture,
) -> None:
    ids = fill_network(conn, network)
    foreign = person(conn, other_network, "Foreign Person")

    response = client.get("/api/v1/export", params={"format": "json"})

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/json")
    document = response.json()
    assert set(document) == {"exported_at", "network_id", "tables"}
    assert document["network_id"] == str(network.network_id)
    assert datetime.fromisoformat(document["exported_at"]).tzinfo is not None
    tables = document["tables"]
    assert set(tables) == NETWORK_TABLES

    people = {p["id"]: p for p in tables["person"]}
    assert set(people) == {str(network.admin_person_id), str(ids["friend"])}
    assert str(foreign) not in people
    friend = people[str(ids["friend"])]
    assert friend["name_ar"] == "صديق"
    assert friend["available_for"] == ["freelance", "job_seeking"]
    assert datetime.fromisoformat(friend["last_confirmed_at"]).tzinfo is not None
    assert [p["id"] for p in tables["person"]] == sorted(people)  # primary-key order
    assert {t["label"] for t in tables["tag"]} == {"Plumbing", "Construction"}
    assert tables["person_skill"][0]["level"] == "expert"
    assert tables["contact_value"][0]["value"] == "010 1234 5678"
    assert tables["connection"][0]["strength"] == "strong"
    assert tables["duplicate_dismissal"] == []
    assert [n["id"] for n in tables["network"]] == [str(network.network_id)]
    assert len(tables["member"]) == 1


def test_export_never_includes_token_hash_or_auth_data(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    fill_network(conn, network)
    user_id = network.admin_claims["sub"]

    json_text = client.get("/api/v1/export", params={"format": "json"}).text
    zipped = client.get("/api/v1/export", params={"format": "csv"}).content

    tables = json.loads(json_text)["tables"]
    assert len(tables["contributor_link"]) == 1
    assert "token_hash" not in tables["contributor_link"][0]
    assert "user_id" not in tables["member"][0]
    assert tables["member"][0]["role"] == "admin"
    archive = zipfile.ZipFile(io.BytesIO(zipped))
    csv_text = "".join(archive.read(name).decode() for name in archive.namelist())
    everything = json_text + csv_text
    for needle in ("token_hash", TOKEN_HASH.hex(), user_id, "@example.test"):
        assert needle not in everything


def test_export_csv_zip_files(
    client: TestClient,
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    other_network: NetworkFixture,
) -> None:
    ids = fill_network(conn, network)
    person(conn, other_network, "Foreign Person")

    response = client.get("/api/v1/export", params={"format": "csv"})

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert set(archive.namelist()) == {f"{t}.csv" for t in NETWORK_TABLES}

    def rows(table: str) -> list[dict[str, str]]:
        text = archive.read(f"{table}.csv").decode("utf-8")
        return list(csv.DictReader(io.StringIO(text, newline="")))

    people = {p["id"]: p for p in rows("person")}
    assert set(people) == {str(network.admin_person_id), str(ids["friend"])}
    friend = people[str(ids["friend"])]
    assert friend["name_ar"] == "صديق"
    assert friend["available_for"] == "freelance;job_seeking"
    assert friend["headline"] == ""
    assert datetime.fromisoformat(friend["last_confirmed_at"]).tzinfo is not None
    assert rows("contact_value")[0]["value"] == "010 1234 5678"
    assert "token_hash" not in rows("contributor_link")[0]

    # An empty table still has its header row.
    empty = archive.read("duplicate_dismissal.csv").decode("utf-8")
    assert empty.strip().split(",") == ["network_id", "person_a", "person_b"]
    assert rows("duplicate_dismissal") == []


def test_export_covers_every_table_of_the_schema(conn: psycopg.Connection[Any]) -> None:
    """A table added by a later migration must be added to the export, not silently left out."""
    rows = conn.execute(
        "select table_name from information_schema.tables"
        " where table_schema = 'public' and table_type = 'BASE TABLE'"
    ).fetchall()
    assert {r[0] for r in rows} == NETWORK_TABLES


@pytest.mark.parametrize(
    ("fmt", "extension", "media_type"),
    [("json", "json", "application/json"), ("csv", "zip", "application/zip")],
)
def test_export_download_headers(
    client: TestClient, fmt: str, extension: str, media_type: str
) -> None:
    response = client.get("/api/v1/export", params={"format": fmt})

    assert response.headers["cache-control"] == "no-store"
    disposition = response.headers["content-disposition"]
    today = datetime.now(UTC).date()
    match = re.fullmatch(
        rf'attachment; filename="connections-export-(\d{{4}}-\d{{2}}-\d{{2}})\.{extension}"',
        disposition,
    )
    assert match, disposition
    assert abs((date.fromisoformat(match.group(1)) - today).days) <= 1
    assert response.headers["content-type"].startswith(media_type)


def test_export_unknown_format_is_422(client: TestClient) -> None:
    for params in ({"format": "xml"}, {"format": ""}):
        assert client.get("/api/v1/export", params=params).status_code == 422


def test_export_defaults_to_json(client: TestClient) -> None:
    response = client.get("/api/v1/export")

    assert response.status_code == 200
    assert "tables" in response.json()


def test_export_does_not_log_row_contents(
    client: TestClient,
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    caplog: pytest.LogCaptureFixture,
) -> None:
    fill_network(conn, network)
    caplog.set_level("DEBUG")

    client.get("/api/v1/export", params={"format": "json"})
    client.get("/api/v1/export", params={"format": "csv"})

    logged = caplog.text
    for secret in ("Friend", "صديق", "010 1234 5678", "linkedin.com/in/friend"):
        assert secret not in logged


# -- admin only ---------------------------------------------------------------------------------

ENDPOINTS = ["/api/v1/review/stale", "/api/v1/review/unreachable", "/api/v1/export"]


@pytest.mark.parametrize("path", ENDPOINTS)
def test_export_requires_admin(
    conn: psycopg.Connection[Any], network: NetworkFixture, path: str
) -> None:
    app = create_app()
    anonymous = TestClient(app)
    assert anonymous.get(path).status_code == 401

    member = TestClient(
        app, headers={"Authorization": f"Bearer {token_for(make_member(conn, network))}"}
    )
    assert member.get(path).status_code == 403

    no_mfa = {**network.admin_claims, "aal": "aal1"}
    password_only = TestClient(app, headers={"Authorization": f"Bearer {token_for(no_mfa)}"})
    assert password_only.get(path).status_code == 403
