"""Exact-match duplicate review and merge, as plain SQL on the caller's admin transaction.

The merge itself is the SQL function `merge_persons` (20261119000007): it runs with the caller's
rights, so row-level security scopes it, and it raises unless the caller is the admin. This module
lists the candidate pairs, records dismissals and maps the function's errors to API errors.
Nothing here logs: contact values must never reach a log line (global constraints).
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg
from psycopg import errors
from psycopg.rows import dict_row

from connections_api.errors import ConflictError, ForbiddenError, ValidationFailed
from connections_api.modules.duplicates.schemas import DuplicatePair, PersonSummary
from connections_api.modules.people import service as people
from connections_api.modules.people.schemas import PersonOut

type Conn = psycopg.Connection[Any]


class CannotDropAccountError(ConflictError):
    code = "cannot_drop_account"
    safe_message = "A person with an account cannot be merged away; keep it instead."


def _unknown_person(field: str) -> ValidationFailed:
    # 422 like the rest of the API: the id arrives in the request body, not in the URL.
    return ValidationFailed(details={"field": field, "reason": "person_not_found"})


def list_pairs(conn: Conn) -> list[DuplicatePair]:
    """Pairs of people sharing a contact value or a social link URL, minus dismissed pairs.

    Compared on the normalized columns (so `+20 10 1234 5678` finds `01012345678`). Phone and
    WhatsApp share one normal form and match across kinds. `y.person_id > x.person_id` makes each
    pair appear once, a before b, the order the connection and dismissal tables store.
    """
    with conn.cursor(row_factory=dict_row) as cur:
        found = cur.execute(
            """
            with shared as (
              select x.person_id as a, y.person_id as b,
                     case when x.kind = 'email' then 'email' else 'phone' end as reason
              from contact_value x
              join contact_value y on y.network_id = x.network_id
                                  and y.value_norm = x.value_norm
                                  and y.person_id > x.person_id
                                  and (y.kind = 'email') = (x.kind = 'email')
              where x.value_norm is not null
              union
              select x.person_id, y.person_id, 'social_link'
              from social_link x
              join social_link y on y.network_id = x.network_id
                                and y.url_norm = x.url_norm
                                and y.person_id > x.person_id
              where x.url_norm is not null
            )
            select s.a, s.b, array_agg(s.reason order by s.reason) as matched_on,
                   pa.name_ar as a_name_ar, pa.name_latin as a_name_latin,
                   pa.profession as a_profession, pa.city as a_city,
                   pb.name_ar as b_name_ar, pb.name_latin as b_name_latin,
                   pb.profession as b_profession, pb.city as b_city
            from shared s
            join person pa on pa.id = s.a
            join person pb on pb.id = s.b
            where not exists (
              select 1 from duplicate_dismissal dd where dd.person_a = s.a and dd.person_b = s.b
            )
            group by s.a, s.b, pa.id, pb.id
            """
        ).fetchall()

    pairs = [
        DuplicatePair(a=_summary(r, "a"), b=_summary(r, "b"), matched_on=r["matched_on"])
        for r in found
    ]
    pairs.sort(key=lambda p: (p.a.display_name, p.b.display_name, p.a.person_id, p.b.person_id))
    return pairs


def _summary(row: dict[str, Any], side: str) -> PersonSummary:
    return PersonSummary(
        person_id=row[side],
        display_name=people.display_name(row[f"{side}_name_ar"], row[f"{side}_name_latin"]),
        profession=row[f"{side}_profession"],
        city=row[f"{side}_city"],
    )


def dismiss(conn: Conn, a: UUID, b: UUID) -> None:
    """Mark the pair "not the same person". Either order; dismissing twice is not an error."""
    for field, person_id in (("a", a), ("b", b)):
        if conn.execute("select 1 from person where id = %s", (person_id,)).fetchone() is None:
            raise _unknown_person(field)
    first, second = sorted((a, b))
    conn.execute(
        "insert into duplicate_dismissal (network_id, person_a, person_b)"
        " values (current_network_id(), %s, %s) on conflict do nothing",
        (first, second),
    )


def merge(conn: Conn, keep: UUID, drop: UUID) -> PersonOut:
    """Fold `drop` into `keep` (SQL `merge_persons`) and return the merged person."""
    try:
        conn.execute("select merge_persons(%s, %s)", (keep, drop))
    except errors.InsufficientPrivilege as exc:
        raise ForbiddenError() from exc
    except errors.NoDataFound as exc:
        raise _unknown_person(exc.diag.message_hint or "keep") from exc
    except errors.InvalidParameterValue as exc:
        raise ValidationFailed(details={"field": "drop", "reason": "same_person"}) from exc
    except errors.ObjectNotInPrerequisiteState as exc:
        raise CannotDropAccountError() from exc
    return people.get_person_or_404(conn, keep)
