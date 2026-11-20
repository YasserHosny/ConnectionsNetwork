"""People, connections and tag autocomplete. Admin-only; the logic lives in service.py."""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, Query, Response, status

from connections_api.deps import AdminContext, admin_tx, current_admin
from connections_api.modules.people import service
from connections_api.modules.people.schemas import (
    ConnectionIn,
    ConnectionPatch,
    ConnectionRecord,
    CreatePersonResponse,
    NewPersonRequest,
    PersonInput,
    PersonOut,
    TagKind,
    TagOut,
)
from connections_api.shared.idempotency import IdempotencyKey

router = APIRouter(tags=["people"])

Admin = Annotated[AdminContext, Depends(current_admin)]
Tx = Annotated[psycopg.Connection[Any], Depends(admin_tx)]


@router.post("/people", response_model=CreatePersonResponse, status_code=status.HTTP_201_CREATED)
def create_person(
    body: NewPersonRequest, admin: Admin, conn: Tx, idempotency_key: IdempotencyKey = None
) -> CreatePersonResponse:
    return service.create_person(conn, admin, body, idempotency_key)


@router.get("/people/{person_id}", response_model=PersonOut)
def get_person(person_id: UUID, _admin: Admin, conn: Tx) -> PersonOut:
    return service.get_person_or_404(conn, person_id)


@router.put("/people/{person_id}", response_model=PersonOut)
def update_person(person_id: UUID, body: PersonInput, admin: Admin, conn: Tx) -> PersonOut:
    return service.update_person(conn, admin, person_id, body)


@router.post("/people/{person_id}/confirm", response_model=PersonOut)
def confirm_person(person_id: UUID, _admin: Admin, conn: Tx) -> PersonOut:
    return service.confirm_person(conn, person_id)


@router.delete("/people/{person_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_person(person_id: UUID, admin: Admin, conn: Tx) -> Response:
    service.delete_person(conn, admin, person_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/connections", response_model=ConnectionRecord, status_code=status.HTTP_201_CREATED)
def create_connection(body: ConnectionIn, admin: Admin, conn: Tx) -> ConnectionRecord:
    return service.create_connection(conn, admin, body)


@router.patch("/connections/{connection_id}", response_model=ConnectionRecord)
def update_connection(
    connection_id: UUID, body: ConnectionPatch, _admin: Admin, conn: Tx
) -> ConnectionRecord:
    return service.update_connection(conn, connection_id, body)


@router.delete("/connections/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_connection(connection_id: UUID, _admin: Admin, conn: Tx) -> Response:
    service.delete_connection(conn, connection_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/tags", response_model=list[TagOut])
def search_tags(
    kind: TagKind, _admin: Admin, conn: Tx, q: Annotated[str, Query(max_length=100)] = ""
) -> list[TagOut]:
    return service.search_tags(conn, kind, q)
