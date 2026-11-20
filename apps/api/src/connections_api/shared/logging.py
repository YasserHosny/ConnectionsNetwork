"""Structured JSON logging with a trace id and redaction.

Contact values (phone, WhatsApp, email) must never reach a log line, and neither may secrets, so
every record passes through ``RedactionFilter`` before it is formatted. The masking is
pattern-based on purpose: a contact value can show up in a message, a log argument, an extra
field or an exception text, and no caller should have to remember to scrub it.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from collections.abc import Awaitable, Callable, Mapping
from contextvars import ContextVar, Token
from datetime import UTC, datetime
from uuid import uuid4

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

__all__ = [
    "AccessLogFilter",
    "JsonFormatter",
    "RedactionFilter",
    "TraceIdMiddleware",
    "configure_logging",
    "get_trace_id",
    "new_trace_id",
    "redact",
    "reset_trace_id",
    "set_trace_id",
]

TRACE_ID_HEADER = "X-Trace-Id"
REDACTED = "[REDACTED]"

_trace_id: ContextVar[str | None] = ContextVar("trace_id", default=None)

_SENSITIVE_KEYS = frozenset(
    {
        "access_token",
        "apikey",
        "api_key",
        "authorization",
        "credential",
        "jwt",
        "password",
        "refresh_token",
        "secret",
        "service_role_key",
        "supabase_anon_key",
        "token",
    }
)
_SECRET_PATTERN = re.compile(
    r"(?i)(bearer\s+)[a-z0-9._~+/=-]+|"
    r"((?:password|token|secret|apikey|api[_-]?key|authorization)=)[^\s&]+"
)
_EMAIL_PATTERN = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# A run of 8 or more digits, also when the digits are grouped with single spaces or hyphens
# ("010 1234 5678", "+20-10-1234-5678"): phone numbers are rarely written as one block.
_DIGITS_PATTERN = re.compile(r"\d(?:[ -]?\d){7,}")

_RESERVED_LOG_RECORD_KEYS = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "message",
        "module",
        "msecs",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "taskName",
        "thread",
        "threadName",
    }
)


def new_trace_id() -> str:
    return uuid4().hex


def set_trace_id(trace_id: str) -> Token[str | None]:
    return _trace_id.set(trace_id)


def reset_trace_id(token: Token[str | None]) -> None:
    _trace_id.reset(token)


def get_trace_id() -> str:
    trace_id = _trace_id.get()
    if trace_id is None:
        trace_id = new_trace_id()
        _trace_id.set(trace_id)
    return trace_id


def redact(value: object) -> object:
    if isinstance(value, str):
        return _redact_text(value)
    if isinstance(value, Mapping):
        return {
            str(key): REDACTED if _is_sensitive_key(str(key)) else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact(item) for item in value)
    return value


class RedactionFilter(logging.Filter):
    """Masks emails, digit runs and secrets in the message and in extra fields of a record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _redact_text(record.getMessage())
        record.args = None
        for key, value in list(record.__dict__.items()):
            if key in _RESERVED_LOG_RECORD_KEYS or key.startswith("_"):
                continue
            record.__dict__[key] = REDACTED if _is_sensitive_key(key) else redact(value)
        return True


class AccessLogFilter(logging.Filter):
    """Reduces a uvicorn access line to ``<method> <path> <status>``.

    uvicorn logs the client address and the request target *with* its query string, and search
    text and tag queries travel there. Keeping only method, path and status mirrors the Nginx
    access log format (``$request_method $uri $status``). A record that does not have uvicorn's
    five access arguments is left untouched.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) == 5:
            _client, method, full_path, _http_version, status_code = args
            path = str(full_path).split("?", 1)[0]
            record.msg = "%s %s %s"
            record.args = (method, path, status_code)
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": redact(record.getMessage()),
            "trace_id": get_trace_id(),
        }

        if record.exc_info:
            payload["exception"] = redact(self.formatException(record.exc_info))

        for key, value in record.__dict__.items():
            if key in _RESERVED_LOG_RECORD_KEYS or key.startswith("_"):
                continue
            payload[key] = REDACTED if _is_sensitive_key(key) else redact(value)

        return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def configure_logging(level: str) -> None:
    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.setLevel(level.upper())

    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(RedactionFilter())
    handler.setFormatter(JsonFormatter())
    root_logger.addHandler(handler)
    # uvicorn installs its own handlers on these loggers, which would bypass the filter above.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True
    # A logger-level filter runs before the record propagates to the handler's redaction filter.
    # create_app() calls this on every build, so replace rather than stack.
    access_logger = logging.getLogger("uvicorn.access")
    for existing in [f for f in access_logger.filters if isinstance(f, AccessLogFilter)]:
        access_logger.removeFilter(existing)
    access_logger.addFilter(AccessLogFilter())
    logging.captureWarnings(True)


class TraceIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        incoming_trace_id = request.headers.get(TRACE_ID_HEADER)
        trace_id = incoming_trace_id.strip() if incoming_trace_id else new_trace_id()
        token = set_trace_id(trace_id)
        try:
            response = await call_next(request)
            response.headers[TRACE_ID_HEADER] = trace_id
            return response
        finally:
            reset_trace_id(token)


def _redact_text(text: str) -> str:
    text = _SECRET_PATTERN.sub(_replace_secret_match, text)
    text = _EMAIL_PATTERN.sub(REDACTED, text)
    return _DIGITS_PATTERN.sub(REDACTED, text)


def _is_sensitive_key(key: str) -> bool:
    normalised = key.lower().replace("-", "_")
    return normalised in _SENSITIVE_KEYS or any(part in normalised for part in _SENSITIVE_KEYS)


def _replace_secret_match(match: re.Match[str]) -> str:
    if match.group(1):
        return f"{match.group(1)}{REDACTED}"
    if match.group(2):
        return f"{match.group(2)}{REDACTED}"
    return REDACTED
