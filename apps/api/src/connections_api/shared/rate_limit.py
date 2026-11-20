"""SlowAPI rate limiting, after PP's shared/rate_limit.py.

Only the contributor endpoints are limited (spec 11.4): they need no account, so the limit is
what stands between a leaked or guessed link and a flood of submissions. Each contributor
endpoint has two budgets, both checked on every request:

  * 30/minute per link: keyed by the sha256 of the X-Contributor-Token header.
  * 60/minute per client address: keyed by the remote IP, so rotating made-up tokens does not
    escape the limit.

The budgets are per endpoint (`key_style="endpoint"`): tag autocomplete while typing does not use
up the budget for submitting people. A request with no or a bad token still spends both budgets,
and is then answered with the same 404 as any other bad token.

SlowAPI logs the bucket key when a limit is exceeded, so the token key is the hash, never the
token itself.

Behind a reverse proxy the remote address is the proxy's unless uvicorn trusts its forwarded
headers (`--proxy-headers --forwarded-allow-ips`); the deployment must set that, or every
contributor shares one per-IP budget.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from connections_api.errors import ErrorEnvelope
from connections_api.modules.links.service import CONTRIBUTOR_TOKEN_HEADER, hash_token
from connections_api.shared.logging import get_trace_id

CONTRIBUTOR_TOKEN_LIMIT = "30/minute"
CONTRIBUTOR_IP_LIMIT = "60/minute"

limiter = Limiter(key_func=get_remote_address, key_style="endpoint")


def contributor_token_key(request: Request) -> str:
    """The rate-limit bucket of the link a request names: the token's hash, hex-encoded."""
    return "link:" + hash_token(request.headers.get(CONTRIBUTOR_TOKEN_HEADER, "")).hex()


def contributor_rate_limits[F: Callable[..., Any]](endpoint: F) -> F:
    """Both contributor budgets on one endpoint. The endpoint must take `request: Request`."""
    per_link = limiter.limit(CONTRIBUTOR_TOKEN_LIMIT, key_func=contributor_token_key)
    per_ip = limiter.limit(CONTRIBUTOR_IP_LIMIT)
    return per_ip(per_link(endpoint))


def configure_rate_limiting(app: FastAPI) -> None:
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)


async def _rate_limit_handler(_request: Request, _exc: Exception) -> JSONResponse:
    envelope = ErrorEnvelope(
        code="rate_limit.exceeded",
        message="Too many requests.",
        details=None,
        trace_id=get_trace_id(),
    )
    return JSONResponse(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        content=envelope.model_dump(mode="json"),
    )
