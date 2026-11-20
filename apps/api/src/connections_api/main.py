from __future__ import annotations

import logging

from fastapi import APIRouter, FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from connections_api import db
from connections_api.config import Settings, get_settings
from connections_api.errors import register_exception_handlers
from connections_api.modules.duplicates.router import router as duplicates_router
from connections_api.modules.export.router import router as export_router
from connections_api.modules.links.router import router as links_router
from connections_api.modules.people.router import router as people_router
from connections_api.modules.review.router import router as review_router
from connections_api.modules.search.router import router as search_router
from connections_api.shared.logging import TraceIdMiddleware, configure_logging
from connections_api.shared.rate_limit import configure_rate_limiting

API_PREFIX = "/api/v1"

logger = logging.getLogger(__name__)

# Seconds the database check waits to connect. The nightly workflow calls it as a keepalive, and
# a database that accepts no connection must fail the check, not hang it.
HEALTH_DB_CONNECT_TIMEOUT = 5

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: str


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get("/health/db", response_model=HealthResponse)
def health_db(response: Response) -> HealthResponse:
    """Liveness of the database: `select 1` through db.connect. No auth (the nightly keepalive).

    The answer carries no error text: an unreachable database is a plain 503, and the log gets
    the exception class only, never its message (which can name hosts).
    """
    try:
        with db.connect(connect_timeout=HEALTH_DB_CONNECT_TIMEOUT) as conn:
            conn.execute("select 1").fetchone()
    except Exception as exc:
        logger.warning("health/db check failed: %s", type(exc).__name__)
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return HealthResponse(status="unavailable")
    return HealthResponse(status="ok")


def create_app(settings: Settings | None = None) -> FastAPI:
    active_settings = settings or get_settings()
    configure_logging("info")

    app = FastAPI(title="Connections Network API")
    app.add_middleware(TraceIdMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(active_settings.api_cors_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)
    configure_rate_limiting(app)

    app.include_router(router, prefix=API_PREFIX)
    app.include_router(people_router, prefix=API_PREFIX)
    app.include_router(search_router, prefix=API_PREFIX)
    app.include_router(duplicates_router, prefix=API_PREFIX)
    app.include_router(links_router, prefix=API_PREFIX)
    app.include_router(review_router, prefix=API_PREFIX)
    app.include_router(export_router, prefix=API_PREFIX)
    return app


app = create_app()
