"""Contributor links: the admin issues, renews and revokes them; contributors use them.

The token is `secrets.token_urlsafe(32)`. It is returned once, inside the URL's fragment (which
browsers never send to a server), and only its sha256 is stored. Contributor requests carry it in
the `X-Contributor-Token` header; it is hashed here, first thing, and only the hash goes to the
database. The plaintext is never stored, logged or put in an exception.

Admin functions take the connection `admin_tx` yields, so RLS scopes them to the admin's network.
Contributor functions run in `contributor_tx()`, as the `contributor_api` role: the only role that
can execute the three SECURITY DEFINER functions of 20261119000008_contributor_link_functions.sql,
and one that holds nothing else. Every way a token can
be wrong (missing, malformed, unknown, expired, revoked) takes the same path, hashing included,
and ends in the same 404 `link_not_found`.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from uuid import UUID

import psycopg
from psycopg import errors
from psycopg.rows import dict_row

from connections_api.db import contributor_tx
from connections_api.deps import AdminContext
from connections_api.errors import ConflictError, NotFoundError, ValidationFailed
from connections_api.modules.links.schemas import (
    ContributeRequest,
    ContributorInfo,
    ContributorTag,
    IssuedLink,
    LinkOut,
)
from connections_api.modules.people.schemas import TagKind
from connections_api.modules.people.service import display_name

type Conn = psycopg.Connection[Any]

TOKEN_BYTES = 32


class LinkNotFoundError(NotFoundError):
    """Every bad contributor token, whatever is wrong with it: one code, one message."""

    code = "link_not_found"
    safe_message = "This link has expired or is no longer valid."


class LinkRevokedError(ConflictError):
    code = "link_revoked"
    safe_message = "A revoked link cannot be renewed; create a new one."


def hash_token(token: str) -> bytes:
    """sha256 of the token, as stored in contributor_link.token_hash."""
    return hashlib.sha256(token.encode()).digest()


def _issue(web_public_url: str, link_id: UUID, expires_at: object, token: str) -> IssuedLink:
    # The token goes in the fragment: it never reaches a server, a proxy or an access log.
    url = f"{web_public_url.rstrip('/')}/c#{token}"
    return IssuedLink.model_validate({"link_id": link_id, "url": url, "expires_at": expires_at})


# -- admin --------------------------------------------------------------------------------------

_LINK_SELECT = """
    select l.id as link_id, l.person_id, p.name_ar, p.name_latin, l.expires_at, l.revoked_at,
           (select count(*) from person added where added.contributor_link_id = l.id)
             as people_added
    from contributor_link l
    join person p on p.network_id = l.network_id and p.id = l.person_id
"""


def _link_out(row: dict[str, Any]) -> LinkOut:
    return LinkOut.model_validate(
        {**row, "display_name": display_name(row.pop("name_ar"), row.pop("name_latin"))}
    )


def create_link(conn: Conn, ctx: AdminContext, person_id: UUID, web_public_url: str) -> IssuedLink:
    token = secrets.token_urlsafe(TOKEN_BYTES)
    row = conn.execute(
        "insert into contributor_link (network_id, person_id, token_hash)"
        " select %s, p.id, %s from person p where p.id = %s"
        " returning id, expires_at",
        (ctx.network_id, hash_token(token), person_id),
    ).fetchone()
    if row is None:
        # 422 like the rest of the API: the id arrives in the request body, not in the URL.
        raise ValidationFailed(details={"field": "person_id", "reason": "person_not_found"})
    return _issue(web_public_url, row[0], row[1], token)


def list_links(conn: Conn) -> list[LinkOut]:
    with conn.cursor(row_factory=dict_row) as cur:
        rows = cur.execute(f"{_LINK_SELECT} order by l.created_at desc, l.id").fetchall()
    return [_link_out(r) for r in rows]


def renew_link(conn: Conn, link_id: UUID, web_public_url: str) -> IssuedLink:
    """A new token (the old one stops working) and a fresh 30 days (the column default)."""
    token = secrets.token_urlsafe(TOKEN_BYTES)
    row = conn.execute(
        "update contributor_link set token_hash = %s, expires_at = default"
        " where id = %s and revoked_at is null returning id, expires_at",
        (hash_token(token), link_id),
    ).fetchone()
    if row is None:
        exists = conn.execute("select 1 from contributor_link where id = %s", (link_id,))
        raise LinkRevokedError() if exists.fetchone() else NotFoundError()
    return _issue(web_public_url, row[0], row[1], token)


def revoke_link(conn: Conn, link_id: UUID) -> LinkOut:
    """Revoke at once; revoking again keeps the first revocation time."""
    with conn.cursor(row_factory=dict_row) as cur:
        revoked = cur.execute(
            "update contributor_link set revoked_at = coalesce(revoked_at, now())"
            " where id = %s returning id",
            (link_id,),
        ).fetchone()
        if revoked is None:
            raise NotFoundError()
        row = cur.execute(f"{_LINK_SELECT} where l.id = %s", (link_id,)).fetchone()  # noqa: S608
    assert row is not None
    return _link_out(row)


# -- contributor --------------------------------------------------------------------------------


@contextmanager
def _contributor_tx() -> Iterator[Conn]:
    """A contributor_api transaction, with the definer functions' errors mapped to API errors.

    invalid_link (28000) is the 404. A payload the database refuses (classes 22 and 23) is a 422
    without details: the API validated the same rules already, and the database's message must
    not be echoed or logged, since it can quote what was sent.
    """
    try:
        with contributor_tx() as conn:
            yield conn
    except errors.InvalidAuthorizationSpecification:
        raise LinkNotFoundError() from None
    except (psycopg.DataError, psycopg.IntegrityError):
        raise ValidationFailed(details={"reason": "invalid_payload"}) from None


def link_info(token: str | None) -> ContributorInfo:
    token_hash = hash_token(token or "")
    with _contributor_tx() as conn, conn.cursor(row_factory=dict_row) as cur:
        row = cur.execute(
            "select * from public.contributor_link_info(%s)", (token_hash,)
        ).fetchone()
    if row is None:
        raise LinkNotFoundError()
    return ContributorInfo.model_validate(row)


def suggest_tags(token: str | None, kind: TagKind, q: str) -> list[ContributorTag]:
    token_hash = hash_token(token or "")
    with _contributor_tx() as conn, conn.cursor(row_factory=dict_row) as cur:
        rows = cur.execute(
            "select label, category from public.contributor_tag_suggest(%s, %s, %s)",
            (token_hash, kind.value, q),
        ).fetchall()
    return [ContributorTag.model_validate(r) for r in rows]


def contribute(token: str | None, request: ContributeRequest) -> UUID:
    token_hash = hash_token(token or "")
    payload = {"person": request.person.payload(), "strength": request.strength.value}
    with _contributor_tx() as conn:
        row = conn.execute(
            "select public.contribute_person(%s, %s::jsonb)", (token_hash, json.dumps(payload))
        ).fetchone()
    assert row is not None
    return row[0]
