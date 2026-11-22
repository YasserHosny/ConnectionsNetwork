"""Export of all the network's data, for the admin to keep (spec 9)."""

from __future__ import annotations

from typing import Annotated, Any

import psycopg
from fastapi import APIRouter, Depends, Query, Response

from connections_api.deps import AdminContext, admin_snapshot_tx, current_admin
from connections_api.modules.export import service
from connections_api.modules.export.service import ExportFormat

router = APIRouter(tags=["export"])

Admin = Annotated[AdminContext, Depends(current_admin)]
Tx = Annotated[psycopg.Connection[Any], Depends(admin_snapshot_tx)]

_MEDIA_TYPES = {ExportFormat.JSON: "application/json", ExportFormat.CSV: "application/zip"}


@router.get("/export", response_class=Response, responses={200: {"description": "The file"}})
def export(
    admin: Admin, conn: Tx, format: Annotated[ExportFormat, Query()] = ExportFormat.JSON
) -> Response:
    """Every table of the network as one JSON document, or a zip with one CSV per table.

    Sent as an attachment and never cached: it holds contact details.
    """
    content, filename = service.export_network(conn, admin.network_id, format)
    return Response(
        content=content,
        media_type=_MEDIA_TYPES[format],
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )
