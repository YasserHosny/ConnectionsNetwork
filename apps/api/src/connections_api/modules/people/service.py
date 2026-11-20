"""People, connections and tags, as plain SQL on the caller's admin transaction.

Every function takes the connection `admin_tx` yields, so row-level security scopes each
statement to the admin's network: an id from another network is simply not found. Nothing here
logs: contact values must never reach a log line (global constraints).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from connections_api.deps import AdminContext
from connections_api.errors import ConflictError, NotFoundError, ValidationFailed
from connections_api.modules.people.schemas import (
    ConnectionIn,
    ConnectionPatch,
    ConnectionRecord,
    CreatePersonResponse,
    DuplicateHint,
    NewPersonRequest,
    PersonInput,
    PersonOut,
    SkillCategory,
    SkillLevel,
    TagKind,
    TagOut,
)

type Conn = psycopg.Connection[Any]
type Row = dict[str, Any]

# Autocomplete: up to this many suggestions; trigram similarity at or above this is "close enough".
TAG_SUGGESTION_LIMIT = 10
TAG_SIMILARITY_THRESHOLD = 0.3


class CannotDeleteSelfError(ConflictError):
    code = "cannot_delete_self"
    safe_message = "The admin's own person cannot be deleted."


def display_name(name_ar: str | None, name_latin: str | None) -> str:
    """The name to show: the Arabic one when present (Arabic is the default language)."""
    return (name_ar or "").strip() or (name_latin or "").strip()


def _rows(conn: Conn, sql: str, params: object = None) -> list[Row]:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(sql, params).fetchall()  # type: ignore[arg-type]


def _row(conn: Conn, sql: str, params: object = None) -> Row | None:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(sql, params).fetchone()  # type: ignore[arg-type]


def _unknown_person(field: str) -> ValidationFailed:
    # 422 rather than 404: the id arrives in the request body, not in the URL being addressed.
    return ValidationFailed(details={"field": field, "reason": "person_not_found"})


def _require_person(conn: Conn, person_id: UUID, field: str) -> None:
    if _row(conn, "select 1 from person where id = %s", (person_id,)) is None:
        raise _unknown_person(field)


# -- tags ---------------------------------------------------------------------------------------


def upsert_tags(
    conn: Conn, kind: TagKind, labels_with_category: Sequence[tuple[str, SkillCategory | None]]
) -> list[UUID]:
    """Tag ids for the labels, in order, through the one tag rule (SQL `upsert_tag`).

    The category is required for a skill and must be None for an industry (the schema enforces it).
    """
    return [
        conn.execute(
            "select upsert_tag(current_network_id(), %s::tag_kind, %s, %s::skill_category)",
            (kind.value, label, category.value if category else None),
        ).fetchone()[0]  # type: ignore[index]
        for label, category in labels_with_category
    ]


def search_tags(conn: Conn, kind: TagKind, q: str) -> list[TagOut]:
    """Autocomplete: prefix matches on the normalized label first, then close spellings.

    An alias answers with its target, once. A blank query lists the first tags alphabetically.
    """
    rows = _rows(
        conn,
        """
        select id, label, category from (
          select distinct on (target.id)
                 target.id, target.label, target.category, target.label_norm,
                 not starts_with(t.label_norm, q.n) as fuzzy,
                 similarity(t.label_norm, q.n) as sim
          from tag t
          join tag target on target.network_id = t.network_id
                         and target.id = coalesce(t.alias_of_tag_id, t.id),
               (select normalize_text(%(q)s) as n) q
          where t.kind = %(kind)s::tag_kind
            and (q.n = ''
                 or starts_with(t.label_norm, q.n)
                 or similarity(t.label_norm, q.n) >= %(threshold)s)
          order by target.id, fuzzy, sim desc
        ) matches
        order by fuzzy, sim desc, label_norm, id
        limit %(limit)s
        """,
        {
            "q": q,
            "kind": kind.value,
            "threshold": TAG_SIMILARITY_THRESHOLD,
            "limit": TAG_SUGGESTION_LIMIT,
        },
    )
    return [TagOut.model_validate(r) for r in rows]


# -- reading a person ---------------------------------------------------------------------------


def get_person(conn: Conn, person_id: UUID) -> PersonOut | None:
    person = _row(
        conn,
        """
        select p.*, p.last_confirmed_at < now() - interval '12 months' as is_stale
        from person p where p.id = %s
        """,
        (person_id,),
    )
    if person is None:
        return None
    skills = _rows(
        conn,
        """
        select t.id as tag_id, t.label, t.category, ps.level
        from person_skill ps join tag t on t.id = ps.tag_id
        where ps.person_id = %s order by t.label_norm, t.id
        """,
        (person_id,),
    )
    industries = _rows(
        conn,
        """
        select t.id as tag_id, t.label
        from person_industry pi join tag t on t.id = pi.tag_id
        where pi.person_id = %s order by t.label_norm, t.id
        """,
        (person_id,),
    )
    social_links = _rows(
        conn,
        "select id, kind, url from social_link where person_id = %s order by kind, url, id",
        (person_id,),
    )
    contacts = _rows(
        conn,
        """
        select id, kind, value, added_by_person_id
        from contact_value where person_id = %s order by kind, value, id
        """,
        (person_id,),
    )
    connections = _rows(
        conn,
        """
        select c.id, o.id as person_id, o.name_ar, o.name_latin, c.strength, c.note
        from connection c
        join person o on o.id = case when c.person_a = %(id)s then c.person_b else c.person_a end
        where %(id)s in (c.person_a, c.person_b)
        order by c.strength, o.search_name, o.id
        """,
        {"id": person_id},
    )
    for c in connections:
        c["display_name"] = display_name(c.pop("name_ar"), c.pop("name_latin"))
    return PersonOut.model_validate(
        {
            **person,
            "display_name": display_name(person["name_ar"], person["name_latin"]),
            "skills": skills,
            "industries": industries,
            "social_links": social_links,
            "contacts": contacts,
            "connections": connections,
        }
    )


def get_person_or_404(conn: Conn, person_id: UUID) -> PersonOut:
    person = get_person(conn, person_id)
    if person is None:
        raise NotFoundError()
    return person


# -- writing a person ---------------------------------------------------------------------------


def _write_tags_and_links(
    conn: Conn, ctx: AdminContext, person_id: UUID, data: PersonInput
) -> None:
    """Skills, industries and social links of a person who currently has none."""
    levels: dict[UUID, SkillLevel | None] = {}
    skill_ids = upsert_tags(conn, TagKind.skill, [(s.label, s.category) for s in data.skills])
    for tag_id, skill in zip(skill_ids, data.skills, strict=True):
        # Two spellings of one tag are one skill; keep a stated level over none.
        levels[tag_id] = levels.get(tag_id) or skill.level
    industry_ids = dict.fromkeys(
        upsert_tags(conn, TagKind.industry, [(label, None) for label in data.industries])
    )
    with conn.cursor() as cur:
        cur.executemany(
            "insert into person_skill (network_id, person_id, tag_id, level)"
            " values (%s, %s, %s, %s::skill_level)",
            [(ctx.network_id, person_id, t, lv.value if lv else None) for t, lv in levels.items()],
        )
        cur.executemany(
            "insert into person_industry (network_id, person_id, tag_id) values (%s, %s, %s)",
            [(ctx.network_id, person_id, t) for t in industry_ids],
        )
        cur.executemany(
            "insert into social_link (network_id, person_id, kind, url)"
            " values (%s, %s, %s::social_link_kind, %s)",
            [(ctx.network_id, person_id, link.kind.value, link.url) for link in data.social_links],
        )


def _insert_contacts(
    conn: Conn, ctx: AdminContext, person_id: UUID, contacts: Sequence[tuple[str, str]]
) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            "insert into contact_value (network_id, person_id, kind, value, added_by_person_id)"
            " values (%s, %s, %s::contact_kind, %s, %s)",
            [(ctx.network_id, person_id, kind, value, ctx.person_id) for kind, value in contacts],
        )


def _incoming_contacts(data: PersonInput) -> list[tuple[str, str]]:
    return list(dict.fromkeys((c.kind.value, c.value) for c in data.contacts))


def _sync_contacts(conn: Conn, ctx: AdminContext, person_id: UUID, data: PersonInput) -> None:
    """Make the person's contact values exactly the incoming ones.

    A value that is unchanged keeps its row, so it keeps who entered it (spec 7.2): an admin
    re-saving the form must not take over a contributor's phone number. New values are the
    admin's; values no longer sent are deleted.
    """
    incoming = _incoming_contacts(data)
    existing = {
        (r["kind"], r["value"]): r["id"]
        for r in _rows(
            conn, "select id, kind, value from contact_value where person_id = %s", (person_id,)
        )
    }
    gone = [row_id for key, row_id in existing.items() if key not in incoming]
    if gone:
        conn.execute("delete from contact_value where id = any(%s)", (gone,))
    _insert_contacts(conn, ctx, person_id, [key for key in incoming if key not in existing])


def _insert_connection(
    conn: Conn,
    ctx: AdminContext,
    one: UUID,
    other: UUID,
    strength: str,
    note: str | None,
) -> None:
    # Stored once per pair, smaller id first (the schema's person_a < person_b).
    person_a, person_b = sorted((one, other))
    try:
        conn.execute(
            "insert into connection"
            " (network_id, person_a, person_b, strength, note, created_by_person_id)"
            " values (%s, %s, %s, %s::connection_strength, %s, %s)",
            (ctx.network_id, person_a, person_b, strength, note, ctx.person_id),
        )
    except psycopg.errors.UniqueViolation as exc:
        raise ConflictError(details={"reason": "already_connected"}) from exc


def _possible_duplicates(conn: Conn, person_id: UUID) -> list[DuplicateHint]:
    """Other people sharing a phone, WhatsApp, email or social link with this one.

    Compared on the normalized columns, so `+20 10 1234 5678` finds `01012345678`. Phone and
    WhatsApp share one normal form and match across kinds; the hint names the kind just entered.
    """
    rows = _rows(
        conn,
        """
        select p.id as person_id, p.name_ar, p.name_latin, mine.kind::text as matched_on,
               p.created_at
        from contact_value mine
        join contact_value other on other.network_id = mine.network_id
                                and other.value_norm = mine.value_norm
                                and other.person_id <> mine.person_id
                                and (other.kind = 'email') = (mine.kind = 'email')
        join person p on p.network_id = other.network_id and p.id = other.person_id
        where mine.person_id = %(id)s and mine.value_norm is not null
        union
        select p.id, p.name_ar, p.name_latin, 'social_link', p.created_at
        from social_link mine
        join social_link other on other.network_id = mine.network_id
                              and other.url_norm = mine.url_norm
                              and other.person_id <> mine.person_id
        join person p on p.network_id = other.network_id and p.id = other.person_id
        where mine.person_id = %(id)s and mine.url_norm is not null
        order by created_at, person_id, matched_on
        """,
        {"id": person_id},
    )
    return [
        DuplicateHint(
            person_id=r["person_id"],
            display_name=display_name(r["name_ar"], r["name_latin"]),
            matched_on=r["matched_on"],
        )
        for r in rows
    ]


def create_person(conn: Conn, ctx: AdminContext, request: NewPersonRequest) -> CreatePersonResponse:
    _require_person(conn, request.connect_to_person_id, "connect_to_person_id")
    data = request.person
    row = conn.execute(
        """
        insert into person
          (network_id, name_ar, name_latin, headline, organization, profession, seniority,
           available_for, city, country, admin_notes, created_by_person_id, created_via)
        values (%s, %s, %s, %s, %s, %s, %s::seniority, %s, %s, %s, %s, %s, 'admin')
        returning id
        """,
        (
            ctx.network_id, data.name_ar, data.name_latin, data.headline, data.organization,
            data.profession, data.seniority.value if data.seniority else None,
            [a.value for a in dict.fromkeys(data.available_for)], data.city, data.country,
            data.admin_notes, ctx.person_id,
        ),
    ).fetchone()  # fmt: skip
    assert row is not None
    person_id: UUID = row[0]

    _write_tags_and_links(conn, ctx, person_id, data)
    _insert_contacts(conn, ctx, person_id, _incoming_contacts(data))
    _insert_connection(
        conn, ctx, person_id, request.connect_to_person_id, request.strength.value,
        request.connection_note,
    )  # fmt: skip
    return CreatePersonResponse(
        person=get_person_or_404(conn, person_id),
        possible_duplicates=_possible_duplicates(conn, person_id),
    )


def update_person(conn: Conn, ctx: AdminContext, person_id: UUID, data: PersonInput) -> PersonOut:
    """Replace the profile, skills, industries, links and contacts; reset `last_confirmed_at`."""
    updated = conn.execute(
        """
        update person set
          name_ar = %s, name_latin = %s, headline = %s, organization = %s, profession = %s,
          seniority = %s::seniority, available_for = %s, city = %s, country = %s,
          admin_notes = %s, last_confirmed_at = now()
        where id = %s returning id
        """,
        (
            data.name_ar, data.name_latin, data.headline, data.organization, data.profession,
            data.seniority.value if data.seniority else None,
            [a.value for a in dict.fromkeys(data.available_for)], data.city, data.country,
            data.admin_notes, person_id,
        ),
    ).fetchone()  # fmt: skip
    if updated is None:
        raise NotFoundError()
    for table in ("person_skill", "person_industry", "social_link"):
        conn.execute(f"delete from {table} where person_id = %s", (person_id,))  # noqa: S608
    _write_tags_and_links(conn, ctx, person_id, data)
    _sync_contacts(conn, ctx, person_id, data)
    return get_person_or_404(conn, person_id)


def confirm_person(conn: Conn, person_id: UUID) -> PersonOut:
    row = conn.execute(
        "update person set last_confirmed_at = now() where id = %s returning id", (person_id,)
    ).fetchone()
    if row is None:
        raise NotFoundError()
    return get_person_or_404(conn, person_id)


def delete_person(conn: Conn, ctx: AdminContext, person_id: UUID) -> None:
    """Delete a person and everything stored about them (every reference cascades)."""
    if person_id == ctx.person_id:
        raise CannotDeleteSelfError()
    if (
        conn.execute("delete from person where id = %s returning id", (person_id,)).fetchone()
        is None
    ):
        raise NotFoundError()


# -- connections --------------------------------------------------------------------------------

_CONNECTION_COLUMNS = "id, person_a, person_b, strength, note, created_by_person_id, created_at"


def create_connection(conn: Conn, ctx: AdminContext, body: ConnectionIn) -> ConnectionRecord:
    _require_person(conn, body.person_a, "person_a")
    _require_person(conn, body.person_b, "person_b")
    _insert_connection(conn, ctx, body.person_a, body.person_b, body.strength.value, body.note)
    person_a, person_b = sorted((body.person_a, body.person_b))
    row = _row(
        conn,
        f"select {_CONNECTION_COLUMNS} from connection where person_a = %s and person_b = %s",  # noqa: S608
        (person_a, person_b),
    )
    return ConnectionRecord.model_validate(row)


def update_connection(conn: Conn, connection_id: UUID, patch: ConnectionPatch) -> ConnectionRecord:
    sets: list[str] = []
    params: list[object] = []
    if "strength" in patch.model_fields_set and patch.strength is not None:
        sets.append("strength = %s::connection_strength")
        params.append(patch.strength.value)
    if "note" in patch.model_fields_set:
        sets.append("note = %s")
        params.append(patch.note)
    if sets:
        sql = (
            f"update connection set {', '.join(sets)} where id = %s returning {_CONNECTION_COLUMNS}"  # noqa: S608
        )
    else:
        sql = f"select {_CONNECTION_COLUMNS} from connection where id = %s"  # noqa: S608
    row = _row(conn, sql, (*params, connection_id))
    if row is None:
        raise NotFoundError()
    return ConnectionRecord.model_validate(row)


def delete_connection(conn: Conn, connection_id: UUID) -> None:
    deleted = conn.execute("delete from connection where id = %s returning id", (connection_id,))
    if deleted.fetchone() is None:
        raise NotFoundError()
