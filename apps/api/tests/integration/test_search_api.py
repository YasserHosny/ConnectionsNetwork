"""Search and alternative paths over HTTP, against a real database under RLS.

Graphs are built as the superuser (outside RLS); requests carry a real admin token, so they pass
through current_admin and admin_tx as in production. The owner is the network's admin person.

Skipped unless TEST_DATABASE_URL is set (CI always sets it).
"""

from __future__ import annotations

import os
from collections.abc import Iterator, Sequence
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from httpx import Response
from integration.helpers import NetworkFixture, drop_network, make_network, token_for

from connections_api import db
from connections_api.main import create_app

DSN = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL is not set")

type Skill = tuple[str, str, str | None]  # (label, category, level)


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


def tag(
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    kind: str,
    label: str,
    category: str | None = None,
) -> UUID:
    row = conn.execute(
        "select upsert_tag(%s, %s::tag_kind, %s, %s::skill_category)",
        (network.network_id, kind, label, category),
    ).fetchone()
    assert row is not None
    return row[0]


def add_person(
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    name: str,
    *,
    name_ar: str | None = None,
    skills: Sequence[Skill] = (),
    industries: Sequence[str] = (),
    **columns: object,
) -> UUID:
    """A person in `network`; `columns` are person columns (profession, city, seniority...)."""
    names = ", ".join(columns)
    marks = ", ".join(["%s"] * len(columns))
    row = conn.execute(
        f"insert into person (network_id, name_ar, name_latin{', ' if columns else ''}{names})"  # noqa: S608
        f" values (%s, %s, %s{', ' if columns else ''}{marks}) returning id",
        (network.network_id, name_ar, name, *columns.values()),
    ).fetchone()
    assert row is not None
    person_id: UUID = row[0]
    for label, category, level in skills:
        conn.execute(
            "insert into person_skill (network_id, person_id, tag_id, level)"
            " values (%s, %s, %s, %s::skill_level)",
            (network.network_id, person_id, tag(conn, network, "skill", label, category), level),
        )
    for label in industries:
        conn.execute(
            "insert into person_industry (network_id, person_id, tag_id) values (%s, %s, %s)",
            (network.network_id, person_id, tag(conn, network, "industry", label)),
        )
    return person_id


def link(
    conn: psycopg.Connection[Any], network: NetworkFixture, a: UUID, b: UUID, strength: str
) -> None:
    one, other = sorted((a, b))
    conn.execute(
        "insert into connection (network_id, person_a, person_b, strength)"
        " values (%s, %s, %s, %s::connection_strength)",
        (network.network_id, one, other, strength),
    )


def search(client: TestClient, **params: object) -> Response:
    return client.get("/api/v1/search", params=params)  # type: ignore[arg-type]


def found(client: TestClient, **params: object) -> list[dict[str, Any]]:
    response = search(client, **params)
    assert response.status_code == 200, response.text
    return response.json()


def names(results: list[dict[str, Any]]) -> list[str]:
    return [r["display_name"] for r in results]


# -- ranking ------------------------------------------------------------------------------------


def test_search_by_skill_ranks_by_cost(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    owner = network.admin_person_id
    ahmed = add_person(conn, network, "Ahmed")
    strong_one = add_person(
        conn, network, "Strong Marketer", skills=[("Marketing", "business", None)]
    )
    weak_one = add_person(
        conn, network, "Weak Marketer", skills=[("Marketing", "business", "expert")]
    )
    link(conn, network, owner, ahmed, "strong")
    link(conn, network, ahmed, strong_one, "strong")
    link(conn, network, owner, weak_one, "weak")

    results = found(client, skill="marketing")

    # Two strong hops (cost 2) beat one weak hop (cost 3), and beat the weak one's higher level.
    assert names(results) == ["Strong Marketer", "Weak Marketer"]
    assert [r["cost"] for r in results] == [2, 3]
    assert [r["steps"] for r in results] == [2, 1]
    assert results[0]["person_id"] == str(strong_one)
    assert results[0]["path"] == [
        {"person_id": str(owner), "display_name": "Network Admin"},
        {"person_id": str(ahmed), "display_name": "Ahmed"},
        {"person_id": str(strong_one), "display_name": "Strong Marketer"},
    ]
    assert results[1]["path"][0]["person_id"] == str(owner)
    assert results[1]["path"][-1]["person_id"] == str(weak_one)


def test_level_breaks_ties(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    # Equal cost; the names sort the opposite way round, so only the level can explain the order.
    for name, level in (
        ("Aaa Basic", "basic"),
        ("Bbb None", None),
        ("Zzz Expert", "expert"),
        ("Mmm Good", "good"),
    ):
        person = add_person(conn, network, name, skills=[("SEO", "business", level)])
        link(conn, network, network.admin_person_id, person, "normal")

    results = found(client, skill="seo")

    assert names(results) == ["Zzz Expert", "Mmm Good", "Aaa Basic", "Bbb None"]
    assert {r["cost"] for r in results} == {2}


def test_equal_cost_and_level_order_by_display_name(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    for name in ("Carol", "alice", "Bob"):
        person = add_person(conn, network, name, skills=[("SEO", "business", "good")])
        link(conn, network, network.admin_person_id, person, "normal")

    assert names(found(client, skill="seo")) == ["alice", "Bob", "Carol"]


def test_unreachable_listed_last(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    reachable = add_person(conn, network, "Zed Reachable", skills=[("SEO", "business", "basic")])
    add_person(conn, network, "Aaa Orphan", skills=[("SEO", "business", "expert")])
    link(conn, network, network.admin_person_id, reachable, "weak")

    results = found(client, skill="seo")

    assert names(results) == ["Zed Reachable", "Aaa Orphan"]
    orphan = results[1]
    assert orphan["cost"] is None
    assert orphan["path"] == []
    assert orphan["steps"] == 0


def test_the_owner_is_never_a_result(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    conn.execute("update person set city = 'Cairo' where id = %s", (network.admin_person_id,))
    other = add_person(conn, network, "Other", city="Cairo")
    link(conn, network, network.admin_person_id, other, "strong")

    assert names(found(client, city="cairo")) == ["Other"]


def test_people_of_another_network_are_never_results(
    client: TestClient,
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    other_network: NetworkFixture,
) -> None:
    add_person(conn, other_network, "Foreign", skills=[("SEO", "business", "expert")])
    mine = add_person(conn, network, "Mine", skills=[("SEO", "business", "basic")])
    link(conn, network, network.admin_person_id, mine, "strong")

    assert names(found(client, skill="seo")) == ["Mine"]


def test_limit_applies_after_ranking(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    for strength, name in (("weak", "Far"), ("strong", "Near"), ("normal", "Middle")):
        person = add_person(conn, network, name, city="Cairo")
        link(conn, network, network.admin_person_id, person, strength)

    assert names(found(client, city="cairo", limit=2)) == ["Near", "Middle"]
    assert len(found(client, city="cairo")) == 3  # the default limit is 20


def test_limit_is_bounded(client: TestClient) -> None:
    assert search(client, city="cairo", limit=50).status_code == 200
    assert search(client, city="cairo", limit=51).status_code == 422
    assert search(client, city="cairo", limit=0).status_code == 422


# -- filters ------------------------------------------------------------------------------------


def test_filters_combine(
    client: TestClient,
    conn: psycopg.Connection[Any],
    network: NetworkFixture,
    other_network: NetworkFixture,
) -> None:
    wanted = add_person(
        conn, network, "Banker Boss", industries=["Banking"], seniority="decision_maker"
    )
    add_person(conn, network, "Banker Clerk", industries=["Banking"], seniority="employee")
    add_person(conn, network, "Retail Boss", industries=["Retail"], seniority="decision_maker")
    add_person(
        conn, other_network, "Foreign Banker", industries=["Banking"], seniority="decision_maker"
    )

    results = found(client, industry="banking", seniority="decision_maker")

    assert [r["person_id"] for r in results] == [str(wanted)]


def test_industry_matches_by_normalized_label(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    add_person(conn, network, "Reader", industries=["نشر الكتب"])
    add_person(conn, network, "Other", industries=["Retail"])

    assert names(found(client, industry="  نشر  الكتب ")) == ["Reader"]
    assert found(client, industry="unknown industry") == []


def test_skill_filter_resolves_aliases_both_ways(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    target = tag(conn, network, "skill", "Marketing", "business")
    alias = tag(conn, network, "skill", "Mktg", "business")
    conn.execute("update tag set alias_of_tag_id = %s where id = %s", (target, alias))
    via_target = add_person(conn, network, "Via Target", skills=[("Marketing", "business", None)])
    # A person who still holds the alias tag itself (the alias was declared after they got it).
    via_alias = add_person(conn, network, "Via Alias")
    conn.execute(
        "insert into person_skill (network_id, person_id, tag_id) values (%s, %s, %s)",
        (network.network_id, via_alias, alias),
    )

    assert {r["person_id"] for r in found(client, skill="MKTG")} == {
        str(via_target),
        str(via_alias),
    }
    assert {r["person_id"] for r in found(client, skill="marketing")} == {
        str(via_target),
        str(via_alias),
    }


def test_several_skills_must_all_match(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    both = add_person(
        conn, network, "Both", skills=[("SEO", "business", None), ("Ads", "business", None)]
    )
    add_person(conn, network, "Only SEO", skills=[("SEO", "business", None)])

    assert [r["person_id"] for r in found(client, skill=["seo", "ads"])] == [str(both)]
    assert found(client, skill=["seo", "no such skill"]) == []


def test_min_level_applies_to_the_matched_skills(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    good = add_person(conn, network, "Good SEO", skills=[("SEO", "business", "good")])
    add_person(conn, network, "Basic SEO", skills=[("SEO", "business", "basic")])
    add_person(conn, network, "Unrated SEO", skills=[("SEO", "business", None)])
    # Expert in something else: that skill is not the one asked about.
    add_person(
        conn,
        network,
        "Expert elsewhere",
        skills=[("SEO", "business", "basic"), ("Ads", "business", "expert")],
    )

    results = found(client, skill="seo", min_level="good")

    assert [r["person_id"] for r in results] == [str(good)]


def test_min_level_alone_means_some_skill_at_that_level(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    add_person(conn, network, "Expert", skills=[("Ads", "business", "expert")])
    add_person(conn, network, "Basic", skills=[("Ads", "business", "basic")])
    add_person(conn, network, "No skills")

    assert names(found(client, min_level="expert")) == ["Expert"]
    assert sorted(names(found(client, min_level="basic"))) == ["Basic", "Expert"]


def test_category_filter(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    polyglot = add_person(
        conn,
        network,
        "Polyglot",
        skills=[("French", "languages", "expert"), ("Excel", "technical", "basic")],
    )
    add_person(conn, network, "Accountant", skills=[("Excel", "technical", "expert")])

    assert [r["person_id"] for r in found(client, category="languages")] == [str(polyglot)]
    # min_level applies to the skills of that category.
    assert [r["person_id"] for r in found(client, category="languages", min_level="expert")] == [
        str(polyglot)
    ]
    assert found(client, category="technical", min_level="good", skill="french") == []
    assert search(client, category="astrology").status_code == 422


def test_city_and_available_for_filters(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    add_person(
        conn,
        network,
        "Cairo Freelancer",
        city="القاهرة",
        available_for=["freelance", "job_seeking"],
    )
    add_person(conn, network, "Cairo Employed", city="القاهرة")
    add_person(conn, network, "Giza Freelancer", city="Giza", available_for=["freelance"])

    assert names(found(client, available_for="freelance", city="القاهره")) == ["Cairo Freelancer"]
    assert sorted(names(found(client, available_for="freelance"))) == [
        "Cairo Freelancer",
        "Giza Freelancer",
    ]
    assert names(found(client, available_for="job_seeking")) == ["Cairo Freelancer"]
    assert search(client, available_for="bartending").status_code == 422


def test_seniority_is_validated(client: TestClient) -> None:
    assert search(client, seniority="intern").status_code == 422
    assert search(client, min_level="legendary").status_code == 422


def test_no_criterion_is_a_422(client: TestClient) -> None:
    for params in ({}, {"limit": 5}, {"q": ""}, {"q": "   "}, {"skill": " "}, {"city": " "}):
        response = search(client, **params)
        assert response.status_code == 422, params
        assert response.json()["details"] == {"reason": "search_needs_a_criterion"}


# -- free text ----------------------------------------------------------------------------------


def test_arabic_variant_query(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    ahmed = add_person(conn, network, "Ahmed Hassan", name_ar="أحمد")
    link(conn, network, network.admin_person_id, ahmed, "strong")
    add_person(conn, network, "Unrelated", name_ar="سعيد")

    for spelling in ("احمد", "إحمد", "أحمد", "احْمَد"):
        assert [r["person_id"] for r in found(client, q=spelling)] == [str(ahmed)], spelling
    assert found(client, q="ahmed")[0]["display_name"] == "أحمد"  # the Arabic name is shown


def test_q_matches_profile_text_and_tags(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    by_name = add_person(conn, network, "Zeinab Marketing")
    by_profession = add_person(conn, network, "P", profession="Brand Marketing lead")
    by_headline = add_person(conn, network, "H", headline="Doing marketing since 2010")
    by_org = add_person(conn, network, "O", organization="Marketing Pro LLC")
    by_skill = add_person(conn, network, "S", skills=[("Digital MARKETING", "business", "good")])
    by_industry = add_person(conn, network, "I", industries=["Marketing services"])
    add_person(
        conn, network, "Nobody", profession="Plumber", skills=[("Welding", "crafts_trades", None)]
    )

    results = found(client, q=" Marketing ")

    assert {r["person_id"] for r in results} == {
        str(p) for p in (by_name, by_profession, by_headline, by_org, by_skill, by_industry)
    }


def test_q_is_a_literal_substring(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    literal = add_person(conn, network, "Literal", headline="100% remote")
    add_person(conn, network, "Wildcard bait", headline="100 percent remote")
    add_person(conn, network, "Underscore bait", headline="a b")
    under = add_person(conn, network, "Under", headline="a_b")

    assert [r["person_id"] for r in found(client, q="100%")] == [str(literal)]
    assert [r["person_id"] for r in found(client, q="a_b")] == [str(under)]


def test_q_combines_with_other_filters(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    wanted = add_person(conn, network, "Sara Mahmoud", city="Cairo")
    add_person(conn, network, "Sara Ali", city="Giza")

    assert [r["person_id"] for r in found(client, q="sara", city="Cairo")] == [str(wanted)]


# -- matched skills -----------------------------------------------------------------------------


def test_matched_skills_are_the_ones_that_matched(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    add_person(
        conn,
        network,
        "Sara",
        city="Cairo",
        skills=[
            ("SEO", "business", "expert"),
            ("Meta Ads", "business", "good"),
            ("Excel", "technical", "basic"),
            ("French", "languages", None),
        ],
    )

    def matched(**params: object) -> list[dict[str, Any]]:
        (result,) = found(client, **params)
        return result["matched_skills"]

    assert matched(skill="seo") == [{"label": "SEO", "level": "expert"}]
    assert matched(category="business") == [
        {"label": "SEO", "level": "expert"},
        {"label": "Meta Ads", "level": "good"},
    ]
    assert matched(q="ads") == [{"label": "Meta Ads", "level": "good"}]
    # skill and category together: the union of what each matched.
    assert matched(skill="excel", category="languages") == [
        {"label": "Excel", "level": "basic"},
        {"label": "French", "level": None},
    ]
    # No skill/category/q criterion: every skill of the person, best level first.
    everything = ["SEO", "Meta Ads", "Excel", "French"]
    assert [m["label"] for m in matched(city="cairo")] == everything
    assert [m["label"] for m in matched(min_level="basic")] == everything


def test_q_matching_only_the_name_lists_no_skills(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    add_person(conn, network, "Sara", skills=[("SEO", "business", "expert")])

    (result,) = found(client, q="sara")

    assert result["matched_skills"] == []


# -- the result row -----------------------------------------------------------------------------


def test_result_fields(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    sara = add_person(
        conn,
        network,
        "Sara Mahmoud",
        profession="Digital Marketing",
        headline="SEO nerd",
        city="Cairo",
        available_for=["freelance"],
    )
    link(conn, network, network.admin_person_id, sara, "strong")

    (result,) = found(client, q="sara")

    assert set(result) == {
        "person_id",
        "display_name",
        "profession",
        "headline",
        "city",
        "matched_skills",
        "available_for",
        "last_confirmed_at",
        "is_stale",
        "path",
        "cost",
        "steps",
    }
    assert result["person_id"] == str(sara)
    assert result["profession"] == "Digital Marketing"
    assert result["headline"] == "SEO nerd"
    assert result["city"] == "Cairo"
    assert result["available_for"] == ["freelance"]
    assert result["cost"] == 1
    assert result["steps"] == 1
    assert result["is_stale"] is False


def test_stale_flag(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    old = add_person(conn, network, "Old", city="Cairo")
    conn.execute(
        "update person set last_confirmed_at = now() - interval '13 months' where id = %s", (old,)
    )
    fresh = add_person(conn, network, "Fresh", city="Cairo")
    conn.execute(
        "update person set last_confirmed_at = now() - interval '11 months' where id = %s", (fresh,)
    )

    by_name = {r["display_name"]: r for r in found(client, city="cairo")}

    assert by_name["Old"]["is_stale"] is True
    assert by_name["Fresh"]["is_stale"] is False


# -- access -------------------------------------------------------------------------------------


def test_search_and_paths_need_an_admin(network: NetworkFixture) -> None:
    anonymous = TestClient(create_app())
    member_token = token_for({**network.admin_claims, "member_role": "member"})
    member = TestClient(create_app(), headers={"Authorization": f"Bearer {member_token}"})
    no_mfa = TestClient(
        create_app(),
        headers={"Authorization": f"Bearer {token_for({**network.admin_claims, 'aal': 'aal1'})}"},
    )
    paths_url = f"/api/v1/people/{uuid4()}/paths"

    assert anonymous.get("/api/v1/search", params={"q": "x"}).status_code == 401
    assert anonymous.get(paths_url).status_code == 401
    assert member.get("/api/v1/search", params={"q": "x"}).status_code == 403
    assert member.get(paths_url).status_code == 403
    assert no_mfa.get("/api/v1/search", params={"q": "x"}).status_code == 403
    assert no_mfa.get(paths_url).status_code == 403


# -- alternative paths --------------------------------------------------------------------------


def test_alternative_paths_endpoint(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    owner = network.admin_person_id
    target = add_person(conn, network, "Target")
    via = {n: add_person(conn, network, n) for n in ("Strong Via", "Normal Via", "Weak Via")}
    link(conn, network, owner, via["Strong Via"], "strong")
    link(conn, network, via["Strong Via"], target, "strong")  # cost 2
    link(conn, network, owner, target, "weak")  # cost 3
    link(conn, network, owner, via["Normal Via"], "normal")
    link(conn, network, via["Normal Via"], target, "normal")  # cost 4
    link(conn, network, owner, via["Weak Via"], "weak")
    link(conn, network, via["Weak Via"], target, "weak")  # cost 6

    default = client.get(f"/api/v1/people/{target}/paths")
    two = client.get(f"/api/v1/people/{target}/paths", params={"k": 2})
    all_of_them = client.get(f"/api/v1/people/{target}/paths", params={"k": 10})

    assert default.status_code == 200, default.text
    assert [p["cost"] for p in default.json()] == [2, 3, 4]  # k defaults to 3
    assert [p["cost"] for p in two.json()] == [2, 3]
    assert [p["cost"] for p in all_of_them.json()] == [2, 3, 4, 6]
    first = default.json()[0]
    assert set(first) == {"cost", "path"}
    assert first["path"] == [
        {"person_id": str(owner), "display_name": "Network Admin"},
        {"person_id": str(via["Strong Via"]), "display_name": "Strong Via"},
        {"person_id": str(target), "display_name": "Target"},
    ]
    assert [len(p["path"]) for p in default.json()] == [3, 2, 3]


def test_alternative_paths_of_an_unreachable_person_is_empty(
    client: TestClient, conn: psycopg.Connection[Any], network: NetworkFixture
) -> None:
    orphan = add_person(conn, network, "Orphan")

    response = client.get(f"/api/v1/people/{orphan}/paths")

    assert response.status_code == 200
    assert response.json() == []


def test_alternative_paths_k_is_bounded(client: TestClient, network: NetworkFixture) -> None:
    url = f"/api/v1/people/{network.admin_person_id}/paths"

    assert client.get(url, params={"k": 1}).status_code == 200
    assert client.get(url, params={"k": 10}).status_code == 200
    assert client.get(url, params={"k": 0}).status_code == 422
    assert client.get(url, params={"k": 11}).status_code == 422
    assert client.get(url, params={"k": "many"}).status_code == 422


def test_alternative_paths_unknown_or_foreign_person_is_404(
    client: TestClient, other_network: NetworkFixture
) -> None:
    for person_id in (uuid4(), other_network.admin_person_id):
        response = client.get(f"/api/v1/people/{person_id}/paths")
        assert response.status_code == 404, person_id
        assert response.json()["code"] == "not_found"


def test_text_filters_are_bounded(client: TestClient) -> None:
    assert search(client, skill=["a"] * 10).status_code == 200
    assert search(client, skill=["a"] * 11).status_code == 422
    assert search(client, q="a" * 201).status_code == 422
    assert search(client, city="a" * 201).status_code == 422
