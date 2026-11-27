"""SlowAPI rate limiting: 60 requests a minute per app key, per endpoint.

The bucket key is a domain-separated hash of the bearer key. SlowAPI logs the bucket key when a
limit is exceeded, so the raw key must not be it, and neither may plain sha256(key), which is the
value the config stores (and `auth` looks up). A request with no key shares one bucket, keyed by
the hash of the empty string.

Limits are checked after authentication (dependencies resolve before the endpoint runs), so a
request with an unknown key is answered 401 and spends no budget. The buckets are in this
process's memory.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded

from assistant_gateway.auth import bearer_token
from assistant_gateway.errors import ErrorEnvelope
from assistant_gateway.logging import get_trace_id

APP_KEY_LIMIT = "60/minute"


def app_key_bucket(request: Request) -> str:
    token = bearer_token(request) or ""
    return "app:" + hashlib.sha256(b"ratelimit:" + token.encode("utf-8")).hexdigest()


limiter = Limiter(key_func=app_key_bucket, key_style="endpoint")


def app_rate_limit[F: Callable[..., Any]](endpoint: F) -> F:
    """The per-app-key budget on one endpoint. The endpoint must take `request: Request`."""
    return limiter.limit(APP_KEY_LIMIT)(endpoint)


def configure_rate_limiting(app: FastAPI) -> None:
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)


async def _rate_limit_handler(_request: Request, _exc: Exception) -> JSONResponse:
    envelope = ErrorEnvelope(
        code="rate_limited",
        message="Too many requests.",
        details=None,
        trace_id=get_trace_id(),
    )
    return JSONResponse(status_code=429, content=envelope.model_dump(mode="json"))
