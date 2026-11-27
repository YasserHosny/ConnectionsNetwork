"""A cap on every request body, enforced before anything parses it.

FastAPI parses a multipart form (Starlette spools the file to disk) before it resolves the app-key
dependency, and before the speech route's own 10 MB check. So the cap is applied here, in a pure
ASGI middleware in front of the app: a declared ``Content-Length`` over the cap is answered 413
without calling the app at all, and a body sent without one (chunked) is counted as it is read
and cut off by the chunk that passes the cap. The app then sees a client disconnect; whatever it
answers to that is dropped, since the 413 has already gone out.

The caps, by path:

- ``/v1/speech/transcribe``: the 10 MB audio cap plus 1 MB for the form fields and multipart
  framing.
- ``/v1/llm/messages``: ``llm_body_limit``, derived from the config, so no request whose text fits
  its use case's ``max_input_chars`` can be refused here, however its JSON is encoded.
- Anything else: 64 KiB. No other route takes a body.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from assistant_gateway.config import GatewayConfig
from assistant_gateway.errors import ErrorEnvelope
from assistant_gateway.logging import get_trace_id

KiB = 1024
MiB = 1024 * KiB

# The audio cap is the speech route's; the rest is room for the other form fields and framing.
MAX_AUDIO_BYTES = 10 * MiB
TRANSCRIBE_BODY_LIMIT = MAX_AUDIO_BYTES + 1 * MiB
DEFAULT_BODY_LIMIT = 64 * KiB

# The most JSON bytes one character can take: an astral one (an emoji) escaped by an ASCII-only
# encoder (Python's json.dumps default) as a surrogate pair, two \uXXXX. Arabic, escaped the same
# way, takes 6; sent as UTF-8 it takes 2.
_JSON_BYTES_PER_CHAR = 12
# Field names, quotes, up to 40 message wrappers, and output_schema, which has no character limit
# of its own.
_JSON_OVERHEAD = 256 * KiB
_MIN_LLM_BODY_LIMIT = 1 * MiB


def llm_body_limit(config: GatewayConfig) -> int:
    """The /v1/llm/messages cap: room for the largest ``max_input_chars`` at 12 bytes a char.

    With the default 20 000 characters that is under 0.5 MB, so the 1 MB floor applies; a config
    that raises ``max_input_chars`` raises the cap with it.
    """
    chars = max(
        (case.max_input_chars for app in config.apps.values() for case in app.use_cases.values()),
        default=0,
    )
    return max(_MIN_LLM_BODY_LIMIT, chars * _JSON_BYTES_PER_CHAR + _JSON_OVERHEAD)


class BodySizeLimit:
    """Refuses a request body over its path's cap with 413 ``request_too_large``."""

    def __init__(self, app: ASGIApp, *, limits: Mapping[str, int], default: int) -> None:
        self._app = app
        self._limits = dict(limits)
        self._default = default

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        limit = self._limits.get(scope["path"], self._default)
        declared = _content_length(scope)
        if declared is not None and declared > limit:
            await _too_large(scope, receive, send)
            return

        received = 0
        refused = False  # this middleware sent the 413
        started = False  # the app started its own response

        async def capped_receive() -> Message:
            nonlocal received, refused
            if refused:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    if not started:
                        refused = True
                        await _too_large(scope, receive, send)
                    # Stop here either way: the app reads no further than the cap.
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal started
            if refused:
                return  # the 413 already went out; the app's answer to the disconnect is dropped
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        await self._app(scope, capped_receive, guarded_send)


def _content_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", ()):
        if name == b"content-length":
            text = value.decode("latin-1").strip()
            return int(text) if text.isdigit() else None
    return None


async def _too_large(scope: Scope, receive: Receive, send: Send) -> None:
    envelope = ErrorEnvelope(
        code="request_too_large",
        message="The request is too large.",
        details=None,
        trace_id=get_trace_id(),
    )
    # Connection: close, so the server drops the connection rather than reading on through the
    # rest of the body to find the next request.
    response: Any = JSONResponse(
        status_code=413,
        content=envelope.model_dump(mode="json"),
        headers={"Connection": "close"},
    )
    await response(scope, receive, send)
