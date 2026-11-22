"""Contributor links: admin link management, and the contributor endpoints (no account).

Admin endpoints need the admin (current_admin) and run under RLS (admin_tx). Contributor
endpoints carry no Authorization header: the link token travels in X-Contributor-Token, they are
rate limited, and they open their own `contributor_api` transaction only once the limits have
passed. The header is read as plain optional text, so a missing or malformed token is never a
422: it takes the same path as an unknown one, to the same 404.

No `from __future__ import annotations` here: SlowAPI wraps the contributor endpoints, and
FastAPI would then resolve their string annotations in SlowAPI's module, where none of these
names exist.
"""

from typing import Annotated, Any
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, Header, Query, Request, status

from connections_api.config import Settings, get_settings
from connections_api.deps import AdminContext, admin_snapshot_tx, admin_tx, current_admin
from connections_api.modules.links import service
from connections_api.modules.links.schemas import (
    ContributeRequest,
    ContributeResponse,
    ContributorInfo,
    ContributorTag,
    CreateLinkRequest,
    IssuedLink,
    LinkOut,
)
from connections_api.modules.people.schemas import TagKind
from connections_api.shared.idempotency import IdempotencyKey
from connections_api.shared.rate_limit import CONTRIBUTOR_TOKEN_HEADER, contributor_rate_limits

router = APIRouter(tags=["links"])

Admin = Annotated[AdminContext, Depends(current_admin)]
Tx = Annotated[psycopg.Connection[Any], Depends(admin_tx)]
# Reads see one snapshot (REPEATABLE READ): see deps.admin_snapshot_tx.
ReadTx = Annotated[psycopg.Connection[Any], Depends(admin_snapshot_tx)]
AppSettings = Annotated[Settings, Depends(get_settings)]
ContributorToken = Annotated[str | None, Header(alias=CONTRIBUTOR_TOKEN_HEADER)]


# -- admin --------------------------------------------------------------------------------------


@router.post("/links", response_model=IssuedLink, status_code=status.HTTP_201_CREATED)
def create_link(
    body: CreateLinkRequest, admin: Admin, conn: Tx, settings: AppSettings
) -> IssuedLink:
    return service.create_link(conn, admin, body.person_id, settings.web_public_url)


@router.get("/links", response_model=list[LinkOut])
def list_links(_admin: Admin, conn: ReadTx) -> list[LinkOut]:
    return service.list_links(conn)


@router.post("/links/{link_id}/renew", response_model=IssuedLink)
def renew_link(link_id: UUID, _admin: Admin, conn: Tx, settings: AppSettings) -> IssuedLink:
    return service.renew_link(conn, link_id, settings.web_public_url)


@router.post("/links/{link_id}/revoke", response_model=LinkOut)
def revoke_link(link_id: UUID, _admin: Admin, conn: Tx) -> LinkOut:
    return service.revoke_link(conn, link_id)


# -- contributor --------------------------------------------------------------------------------


@router.get("/contribute/info", response_model=ContributorInfo)
@contributor_rate_limits
def contributor_info(request: Request, token: ContributorToken = None) -> ContributorInfo:
    return service.link_info(token)


@router.get("/contribute/tags", response_model=list[ContributorTag])
@contributor_rate_limits
def contributor_tags(
    request: Request,
    kind: TagKind,
    q: Annotated[str, Query(max_length=100)] = "",
    token: ContributorToken = None,
) -> list[ContributorTag]:
    return service.suggest_tags(token, kind, q)


@router.post(
    "/contribute/people", response_model=ContributeResponse, status_code=status.HTTP_201_CREATED
)
@contributor_rate_limits
def contribute_person(
    request: Request,
    body: ContributeRequest,
    token: ContributorToken = None,
    idempotency_key: IdempotencyKey = None,
) -> ContributeResponse:
    return ContributeResponse(person_id=service.contribute(token, body, idempotency_key))
