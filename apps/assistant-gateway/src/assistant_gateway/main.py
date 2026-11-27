from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager

from fastapi import FastAPI

from assistant_gateway import db, migrate
from assistant_gateway.config import GatewayConfig, load_config
from assistant_gateway.errors import register_exception_handlers
from assistant_gateway.logging import TraceIdMiddleware, configure_logging
from assistant_gateway.providers.anthropic_llm import LazyAnthropicProvider
from assistant_gateway.providers.llm import LlmProvider
from assistant_gateway.providers.openai_speech import LazyOpenAiSpeechProvider
from assistant_gateway.providers.speech import SpeechProvider
from assistant_gateway.rate_limit import configure_rate_limiting
from assistant_gateway.routes.health import router as health_router
from assistant_gateway.routes.llm import router as llm_router
from assistant_gateway.routes.speech import router as speech_router
from assistant_gateway.routes.status import router as status_router
from assistant_gateway.routes.usage import router as usage_router
from assistant_gateway.settings import Settings, get_settings

logger = logging.getLogger(__name__)


def check_schema(database_url: str) -> None:
    """Raise RuntimeError, naming the versions, when a migration has not been applied."""
    with db.connect(database_url, autocommit=True) as conn:
        versions = migrate.pending(conn)
    if versions:
        message = "pending migration " + ", ".join(versions)
        logger.error("startup refused: %s (run python -m assistant_gateway.migrate)", message)
        raise RuntimeError(message)


def create_app(
    settings: Settings | None = None,
    *,
    config: GatewayConfig | None = None,
    llm: LlmProvider | None = None,
    speech: Mapping[str, SpeechProvider] | None = None,
    check_migrations: bool = True,
) -> FastAPI:
    """Build the app. ``check_migrations=False`` skips the startup schema check (tests that
    enter the lifespan without a database)."""
    # Resolving settings and the config here fails fast when the environment is incomplete.
    settings = settings or get_settings()
    if config is None:
        config = load_config(settings.ag_config_path, os.environ)
    configure_logging("info")

    database_url = settings.ag_database_url.get_secret_value()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Runs when the server starts, not when the module is imported. The check is a one-off
        # blocking query, fine before the first request is served.
        if check_migrations:
            check_schema(database_url)
        yield

    app = FastAPI(title="Connections Network Assistant Gateway", lifespan=lifespan)
    app.add_middleware(TraceIdMiddleware)
    app.state.config = config
    # The real provider reads its key on first use, so the app boots without one (tests, local
    # dev); a call then fails as provider_unavailable.
    app.state.llm = llm or LazyAnthropicProvider(config.providers.anthropic.api_key_env)
    app.state.speech = speech if speech is not None else _speech_registry(config)
    register_exception_handlers(app)
    configure_rate_limiting(app)
    app.include_router(health_router)
    app.include_router(status_router)
    app.include_router(usage_router)
    app.include_router(llm_router)
    app.include_router(speech_router)
    return app


def _speech_registry(config: GatewayConfig) -> dict[str, SpeechProvider]:
    """One adapter per configured speech provider that has one (only OpenAI so far).

    Like the Claude provider, each reads its key on first use: a missing key fails the call, not
    the boot.
    """
    registry: dict[str, SpeechProvider] = {}
    if config.providers.openai is not None:
        openai = config.providers.openai
        registry["openai"] = LazyOpenAiSpeechProvider(openai.api_key_env, openai.model)
    return registry


app = create_app()
