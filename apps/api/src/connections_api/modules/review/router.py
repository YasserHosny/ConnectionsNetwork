"""Review lists for the admin: stale profiles and people not connected to the owner."""

from __future__ import annotations

from typing import Annotated, Any

import psycopg
from fastapi import APIRouter, Depends

from connections_api.deps import AdminContext, admin_tx, current_admin
from connections_api.modules.review import service
from connections_api.modules.review.schemas import ReviewPerson

router = APIRouter(tags=["review"])

Admin = Annotated[AdminContext, Depends(current_admin)]
Tx = Annotated[psycopg.Connection[Any], Depends(admin_tx)]


@router.get("/review/stale", response_model=list[ReviewPerson])
def stale(_admin: Admin, conn: Tx) -> list[ReviewPerson]:
    """People last confirmed more than 12 months ago, oldest first."""
    return service.stale_people(conn)


@router.get("/review/unreachable", response_model=list[ReviewPerson])
def unreachable(admin: Admin, conn: Tx) -> list[ReviewPerson]:
    """People with no path from the owner (the owner excluded), ordered by display name."""
    return service.unreachable_people(conn, admin)
