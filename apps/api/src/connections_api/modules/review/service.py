"""Review lists: profiles to re-confirm (stale) and people the owner cannot reach (spec 8.8, 9).

Both are computed when viewed, on the admin's transaction, so row-level security scopes them to
the admin's network. Nothing here logs: the lists are names.
"""

from __future__ import annotations

from typing import Any

import psycopg
from psycopg.rows import dict_row

from connections_api.deps import AdminContext
from connections_api.modules.graph.loader import load_graph
from connections_api.modules.graph.paths import shortest_paths_from
from connections_api.modules.people.service import display_name, is_stale_sql
from connections_api.modules.review.schemas import ReviewPerson

type Conn = psycopg.Connection[Any]
type Row = dict[str, Any]

_COLUMNS = "p.id, p.name_ar, p.name_latin, p.profession, p.city, p.last_confirmed_at"


def _rows(conn: Conn, sql: str, params: object = None) -> list[Row]:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(sql, params).fetchall()  # type: ignore[arg-type]


def _review_person(row: Row) -> ReviewPerson:
    return ReviewPerson(
        person_id=row["id"],
        display_name=display_name(row["name_ar"], row["name_latin"]),
        profession=row["profession"],
        city=row["city"],
        last_confirmed_at=row["last_confirmed_at"],
    )


def stale_people(conn: Conn) -> list[ReviewPerson]:
    """Everyone last confirmed over 12 months ago, the longest-unconfirmed first."""
    rows = _rows(
        conn,
        f"select {_COLUMNS} from person p where {is_stale_sql('p')}"  # noqa: S608
        " order by p.last_confirmed_at, p.id",
    )
    return [_review_person(r) for r in rows]


def unreachable_people(conn: Conn, ctx: AdminContext) -> list[ReviewPerson]:
    """Everyone with no path from the owner (the owner excluded), by display name.

    People left behind when a bridging person is deleted show up here, so the admin can
    reconnect them (spec 9).
    """
    reachable = shortest_paths_from(load_graph(conn), ctx.person_id)
    rows = _rows(
        conn,
        f"select {_COLUMNS} from person p where p.id <> %s",  # noqa: S608
        (ctx.person_id,),
    )
    people = [_review_person(r) for r in rows if r["id"] not in reachable]
    # Same total order as search: case-insensitive name, then the exact name, then the id.
    people.sort(key=lambda p: (p.display_name.casefold(), p.display_name, str(p.person_id)))
    return people
