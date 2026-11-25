"""SlowAPI rate limiting, after PP's shared/rate_limit.py.

Only the endpoints that need no account are limited. The contributor endpoints (spec 11.4): the
limit is what stands between a leaked or guessed link and a flood of submissions. And
GET /health/db, which opens a database connection per call (HEALTH_DB_LIMIT per client address).
Each contributor endpoint has two budgets, both checked on every request:

  * 30/minute per link: keyed by sha256(b"ratelimit:" + X-Contributor-Token).
  * 60/minute per client address: keyed by the remote IP, so rotating made-up tokens does not
    escape the limit.

The budgets are per endpoint (`key_style="endpoint"`): tag autocomplete while typing does not use
up the budget for submitting people. A request with no or a bad token still spends both budgets,
and is then answered with the same 404 as any other bad token.

SlowAPI logs the bucket key when a limit is exceeded. The per-link key is therefore a hash of
the token, and a domain-separated one: plain sha256(token) is what contributor_link.token_hash
stores, which the contributor functions accept, so it must not reach a log line either.

Behind a reverse proxy the remote address is the proxy's unless uvicorn trusts its forwarded
headers (`--proxy-headers --forwarded-allow-ips`); the deployment must set that, or every
contributor shares one per-IP budget. Nginx in turn must hand uvicorn the visitor, not its own
peer (bunny.net's edge): it takes the visitor from the edge's X-Real-IP (infra/nginx/nginx.conf,
checked by scripts/test-real-ip.sh).
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from connections_api.errors import ErrorEnvelope
from connections_api.shared.logging import get_trace_id

# The header a contributor request carries its link token in (the token is in the URL fragment,
# so it never reaches a server in a URL).
CONTRIBUTOR_TOKEN_HEADER = "X-Contributor-Token"
CONTRIBUTOR_TOKEN_LIMIT = "30/minute"
CONTRIBUTOR_IP_LIMIT = "60/minute"
# The nightly keepalive calls it once; anything near this is not the keepalive.
HEALTH_DB_LIMIT = "30/minute"

limiter = Limiter(key_func=get_remote_address, key_style="endpoint")


def contributor_token_key(request: Request) -> str:
    """The rate-limit bucket of the link a request names. Never equal to the stored token_hash."""
    token = request.headers.get(CONTRIBUTOR_TOKEN_HEADER, "")
    return "link:" + hashlib.sha256(b"ratelimit:" + token.encode()).hexdigest()


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
