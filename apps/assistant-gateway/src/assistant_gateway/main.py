from __future__ import annotations

from fastapi import FastAPI

from assistant_gateway.errors import register_exception_handlers
from assistant_gateway.logging import TraceIdMiddleware, configure_logging
from assistant_gateway.routes.health import router as health_router
from assistant_gateway.settings import Settings, get_settings


def create_app(settings: Settings | None = None) -> FastAPI:
    # Later tasks read settings (database, config path); resolving it here fails fast when the
    # environment is incomplete.
    _ = settings or get_settings()
    configure_logging("info")

    app = FastAPI(title="Connections Network Assistant Gateway")
    app.add_middleware(TraceIdMiddleware)
    register_exception_handlers(app)
    app.include_router(health_router)
    return app


app = create_app()
