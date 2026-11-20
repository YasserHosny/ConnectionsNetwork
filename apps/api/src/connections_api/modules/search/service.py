"""Search: SQL picks the candidate people, the connection graph ranks them (spec 8.6).

Per request: the filters become one SQL query over the people of the admin's network (row-level
security scopes it; the owner is excluded), every connection of the network is loaded once, and
`shortest_paths_from(owner)` ranks the candidates. Nothing here logs: search text can be a name.

Filter semantics (each given filter must hold; they combine with AND):
  * `q`          normalized substring of search_name, profession, headline or organization, or of
                 the label of any of the person's skills or industries.
  * `skill`      repeatable; the person must have every one. A label is matched through
                 normalize_text and follows tag aliases, as `upsert_tag` does when a person's
                 tags are written, so a person holding "marketing" is found by "mktg" and the
                 reverse. A label that names no tag matches nobody.
  * `category`   the person has at least one skill of that category.
  * `min_level`  the matched skills must have at least that level (no level fails it): each
                 `skill`, the `category` skill, or, when neither is given, some skill.
  * `industry`   the person has the industry; matched like a skill label, alias-aware.
  * `city`       normalize_text equality. `seniority`: equality. `available_for`: contained.

`matched_skills` is the person's skills that matched `skill`, `category` or `q` (all of the
person's skills when none of the three is given). `min_level` narrows who is found, not what
is listed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from connections_api.deps import AdminContext
from connections_api.errors import NotFoundError, ValidationFailed
from connections_api.modules.graph.paths import (
    Graph,
    PathResult,
    build_graph,
    k_shortest_paths,
    shortest_paths_from,
)
from connections_api.modules.people.schemas import (
    AvailableFor,
    Seniority,
    SkillCategory,
    SkillLevel,
    Strength,
)
from connections_api.modules.people.service import display_name, is_stale_sql
from connections_api.modules.search.schemas import (
    AlternativePath,
    MatchedSkill,
    PathNode,
    SearchResult,
)

type Conn = psycopg.Connection[Any]
type Row = dict[str, Any]

# Highest level first when ranking; a person with no (matched) level ranks below all of them.
_LEVEL_RANK: dict[SkillLevel, int] = {level: rank for rank, level in enumerate(SkillLevel, 1)}

# upsert_tag follows an alias chain at most this far; search follows it the same distance.
_ALIAS_HOPS = 8


@dataclass(frozen=True)
class SearchCriteria:
    q: str | None = None
    skills: tuple[str, ...] = ()
    category: SkillCategory | None = None
    min_level: SkillLevel | None = None
    industry: str | None = None
    seniority: Seniority | None = None
    available_for: AvailableFor | None = None
    city: str | None = None
    limit: int = 20


def _rows(conn: Conn, sql: str, params: object = None) -> list[Row]:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(sql, params).fetchall()  # type: ignore[arg-type]


def _normalize(conn: Conn, text: str) -> str:
    """normalize_text in the database: the one definition of how text is folded for search."""
    row = conn.execute("select normalize_text(%s)", (text,)).fetchone()
    assert row is not None
    return row[0]


def _like_pattern(normalized: str) -> str:
    """`%normalized%` with LIKE's own wildcards escaped, so the text is matched literally."""
    escaped = normalized.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _equivalent_tag_ids(conn: Conn, kind: str, label: str) -> list[UUID]:
    """Ids of every tag that means `label`: its alias target and all aliases of that target.

    Empty when no tag of that kind has the label (normalized).
    """
    rows = conn.execute(
        """
        with recursive
          up (id, alias_of, hops) as (
            select t.id, t.alias_of_tag_id, 0 from tag t
            where t.kind = %(kind)s::tag_kind and t.label_norm = normalize_text(%(label)s)
            union all
            select t.id, t.alias_of_tag_id, up.hops + 1
            from up join tag t on t.id = up.alias_of
            where up.hops < %(hops)s
          ),
          target (id) as (select id from up order by hops desc limit 1),
          down (id, hops) as (
            select id, 0 from target
            union all
            select t.id, down.hops + 1
            from down join tag t on t.alias_of_tag_id = down.id
            where down.hops < %(hops)s
          )
        select distinct id from down
        """,
        {"kind": kind, "label": label, "hops": _ALIAS_HOPS},
    ).fetchall()
    return [r[0] for r in rows]


_TEXT_MATCH = """(
      p.search_name like %(q_like)s
   or normalize_text(p.profession) like %(q_like)s
   or normalize_text(p.headline) like %(q_like)s
   or normalize_text(p.organization) like %(q_like)s
   or exists (select 1 from person_skill ps join tag t on t.id = ps.tag_id
              where ps.person_id = p.id and t.label_norm like %(q_like)s)
   or exists (select 1 from person_industry pi join tag t on t.id = pi.tag_id
              where pi.person_id = p.id and t.label_norm like %(q_like)s)
)"""


def _load_graph(conn: Conn) -> Graph:
    """Every connection of the admin's network (row-level security), once per request."""
    rows = conn.execute("select person_a, person_b, strength from connection").fetchall()
    return build_graph((a, b, Strength(strength)) for a, b, strength in rows)


def _names(conn: Conn, person_ids: set[UUID]) -> dict[UUID, str]:
    rows = _rows(
        conn,
        "select id, name_ar, name_latin from person where id = any(%s)",
        (list(person_ids),),
    )
    return {r["id"]: display_name(r["name_ar"], r["name_latin"]) for r in rows}


def _path_nodes(path: list[UUID], names: dict[UUID, str]) -> list[PathNode]:
    return [PathNode(person_id=p, display_name=names[p]) for p in path]


@dataclass(frozen=True)
class _Plan:
    """The SQL conditions for a search, and what the matched-skills pass needs to recognise."""

    conditions: list[str]
    params: dict[str, object]
    skill_tag_ids: set[UUID]
    q_norm: str | None
    category: SkillCategory | None
    criteria_for_skills: bool  # skill, category or q was given


def _plan(conn: Conn, ctx: AdminContext, c: SearchCriteria) -> _Plan | None:
    """The query for these criteria; None when a criterion can match nobody (unknown tag).

    Raises 422 when there is no criterion at all.
    """
    q_norm = _normalize(conn, c.q.strip()) if c.q and c.q.strip() else None
    skills = [s for s in (s.strip() for s in c.skills) if s]
    industry = (c.industry or "").strip()
    city = (c.city or "").strip()
    given = (q_norm, skills, c.category, c.min_level, industry, c.seniority, c.available_for, city)
    if not any(given):
        raise ValidationFailed(details={"reason": "search_needs_a_criterion"})

    conditions = ["p.id <> %(owner)s"]
    params: dict[str, object] = {"owner": ctx.person_id}
    level_floor = " and ps.level >= %(min_level)s::skill_level" if c.min_level else ""
    if c.min_level:
        params["min_level"] = c.min_level.value

    if q_norm:
        params["q_like"] = _like_pattern(q_norm)
        conditions.append(_TEXT_MATCH)
    if c.seniority:
        params["seniority"] = c.seniority.value
        conditions.append("p.seniority = %(seniority)s::seniority")
    if c.available_for:
        params["available_for"] = c.available_for.value
        conditions.append("%(available_for)s::text = any(p.available_for)")
    if city:
        params["city"] = city
        conditions.append("normalize_text(p.city) = normalize_text(%(city)s)")

    if industry:
        ids = _equivalent_tag_ids(conn, "industry", industry)
        if not ids:
            return None
        params["industry_ids"] = ids
        conditions.append(
            "exists (select 1 from person_industry pi"
            " where pi.person_id = p.id and pi.tag_id = any(%(industry_ids)s))"
        )

    skill_tag_ids: set[UUID] = set()
    for i, label in enumerate(skills):
        ids = _equivalent_tag_ids(conn, "skill", label)
        if not ids:
            return None
        skill_tag_ids.update(ids)
        params[f"skill_{i}"] = ids
        conditions.append(
            "exists (select 1 from person_skill ps"  # noqa: S608 - only the param name varies
            f" where ps.person_id = p.id and ps.tag_id = any(%(skill_{i})s){level_floor})"
        )
    if c.category:
        params["category"] = c.category.value
        conditions.append(
            "exists (select 1 from person_skill ps join tag t on t.id = ps.tag_id"
            " where ps.person_id = p.id and t.category = %(category)s::skill_category"
            f"{level_floor})"
        )
    if c.min_level and not skills and not c.category:
        conditions.append(
            f"exists (select 1 from person_skill ps where ps.person_id = p.id{level_floor})"
        )

    return _Plan(
        conditions=conditions,
        params=params,
        skill_tag_ids=skill_tag_ids,
        q_norm=q_norm,
        category=c.category,
        criteria_for_skills=bool(skills or c.category or q_norm),
    )


def _matched_skills(conn: Conn, plan: _Plan, person_ids: list[UUID]) -> dict[UUID, list[Row]]:
    """Per person, the skills that matched the criteria, highest level first."""
    rows = _rows(
        conn,
        """
        select ps.person_id, t.id as tag_id, t.label, t.label_norm, t.category, ps.level
        from person_skill ps join tag t on t.id = ps.tag_id
        where ps.person_id = any(%s)
        """,
        (person_ids,),
    )
    by_person: dict[UUID, list[Row]] = {pid: [] for pid in person_ids}
    for r in rows:
        matches = (
            not plan.criteria_for_skills
            or r["tag_id"] in plan.skill_tag_ids
            or (plan.category is not None and r["category"] == plan.category)
            or (plan.q_norm is not None and plan.q_norm in r["label_norm"])
        )
        if matches:
            by_person[r["person_id"]].append(r)
    for skills in by_person.values():
        skills.sort(key=lambda r: (-_level_rank(r["level"]), r["label_norm"], r["tag_id"]))
    return by_person


def _level_rank(level: str | None) -> int:
    return _LEVEL_RANK[SkillLevel(level)] if level else 0


def search_people(conn: Conn, ctx: AdminContext, criteria: SearchCriteria) -> list[SearchResult]:
    """People matching the criteria, closest to the owner first (see the module docstring).

    Order: reachable before unreachable, then lower path cost, then higher best matched skill
    level (expert, good, basic, none), then display name (and id, so the order is total).
    """
    plan = _plan(conn, ctx, criteria)
    if plan is None:
        return []
    candidates = _rows(
        conn,
        f"""
        select p.id, p.name_ar, p.name_latin, p.profession, p.headline, p.city, p.available_for,
               p.last_confirmed_at, {is_stale_sql("p")} as is_stale
        from person p
        where {" and ".join(plan.conditions)}
        """,  # noqa: S608 - conditions are fixed fragments; every value is a bound parameter
        plan.params,
    )
    if not candidates:
        return []

    skills = _matched_skills(conn, plan, [c["id"] for c in candidates])
    paths = shortest_paths_from(_load_graph(conn), ctx.person_id)

    def ranked(c: Row) -> tuple[bool, int, int, str, str, str]:
        found = paths.get(c["id"])
        name = display_name(c["name_ar"], c["name_latin"])
        best = max((_level_rank(s["level"]) for s in skills[c["id"]]), default=0)
        return (
            found is None,
            found.cost if found else 0,
            -best,
            name.casefold(),
            name,
            str(c["id"]),
        )

    top = sorted(candidates, key=ranked)[: criteria.limit]
    reachable: dict[UUID, PathResult] = {c["id"]: paths[c["id"]] for c in top if c["id"] in paths}
    names = _names(conn, {node for r in reachable.values() for node in r.path})

    results = []
    for c in top:
        found = reachable.get(c["id"])
        results.append(
            SearchResult(
                person_id=c["id"],
                display_name=display_name(c["name_ar"], c["name_latin"]),
                profession=c["profession"],
                headline=c["headline"],
                city=c["city"],
                matched_skills=[
                    MatchedSkill(label=s["label"], level=s["level"]) for s in skills[c["id"]]
                ],
                available_for=c["available_for"],
                last_confirmed_at=c["last_confirmed_at"],
                is_stale=c["is_stale"],
                path=_path_nodes(found.path, names) if found else [],
                cost=found.cost if found else None,
                steps=len(found.path) - 1 if found else 0,
            )
        )
    return results


def alternative_paths(
    conn: Conn, ctx: AdminContext, person_id: UUID, k: int
) -> list[AlternativePath]:
    """Up to `k` best distinct paths from the owner to the person, cheapest first.

    404 for a person who does not exist in the admin's network. An unreachable person has none.
    """
    exists = conn.execute("select 1 from person where id = %s", (person_id,)).fetchone()
    if exists is None:
        raise NotFoundError()
    found = k_shortest_paths(_load_graph(conn), ctx.person_id, person_id, k)
    names = _names(conn, {node for r in found for node in r.path})
    return [AlternativePath(cost=r.cost, path=_path_nodes(r.path, names)) for r in found]
