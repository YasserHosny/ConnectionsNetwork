"""App authentication: a bearer key per calling app, matched by its sha256 against the config.

The key itself is never stored, compared as text, logged or put in an error. Only its hash is
looked up (`GatewayConfig.app_for_key_hash` compares in constant time against every app).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from fastapi import Request

from assistant_gateway.config import AppConfig, GatewayConfig, UseCaseConfig
from assistant_gateway.errors import GatewayError


@dataclass(frozen=True)
class AppContext:
    name: str
    config: AppConfig


def bearer_token(request: Request) -> str | None:
    """The key in `Authorization: Bearer <key>`, or None when absent, empty or another scheme."""
    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        return None
    return token


def current_app(request: Request) -> AppContext:
    """FastAPI dependency: the app the bearer key belongs to, else 401."""
    token = bearer_token(request)
    if token is not None:
        config: GatewayConfig = request.app.state.config
        found = config.app_for_key_hash(hashlib.sha256(token.encode("utf-8")).hexdigest())
        if found is not None:
            return AppContext(name=found[0], config=found[1])
    raise GatewayError(401, "auth.unauthenticated", "Missing or unknown app key.")


def use_case_of(ctx: AppContext, name: str) -> UseCaseConfig:
    """The caller's own use case `name`, else 422."""
    use_case = ctx.config.use_cases.get(name)
    if use_case is None:
        raise GatewayError(422, "unknown_use_case", "Unknown use case.")
    return use_case
