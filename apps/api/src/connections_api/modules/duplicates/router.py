"""Duplicate review: candidate pairs, dismissals and merges. Admin-only; logic in service.py."""

from __future__ import annotations

from typing import Annotated, Any

import psycopg
from fastapi import APIRouter, Depends, Response, status

from connections_api.deps import AdminContext, admin_snapshot_tx, admin_tx, current_admin
from connections_api.modules.duplicates import service
from connections_api.modules.duplicates.schemas import (
    DismissRequest,
    DuplicatePair,
    MergeRequest,
)
from connections_api.modules.people.schemas import PersonOut

router = APIRouter(tags=["duplicates"])

Admin = Annotated[AdminContext, Depends(current_admin)]
Tx = Annotated[psycopg.Connection[Any], Depends(admin_tx)]
# Reads see one snapshot (REPEATABLE READ): see deps.admin_snapshot_tx.
ReadTx = Annotated[psycopg.Connection[Any], Depends(admin_snapshot_tx)]


@router.get("/duplicates", response_model=list[DuplicatePair])
def list_duplicates(_admin: Admin, conn: ReadTx) -> list[DuplicatePair]:
    return service.list_pairs(conn)


@router.post("/duplicates/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss_duplicate(body: DismissRequest, _admin: Admin, conn: Tx) -> Response:
    service.dismiss(conn, body.a, body.b)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/duplicates/merge", response_model=PersonOut)
def merge_duplicates(body: MergeRequest, _admin: Admin, conn: Tx) -> PersonOut:
    return service.merge(conn, body.keep, body.drop)
