from __future__ import annotations

import logging
from collections.abc import Sequence

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from assistant_gateway.logging import get_trace_id, redact

logger = logging.getLogger(__name__)

type ErrorDetails = dict[str, object] | list[dict[str, object]] | None


class ErrorEnvelope(BaseModel):
    code: str
    message: str
    details: ErrorDetails = None
    trace_id: str = Field(min_length=1)


class GatewayError(Exception):
    """An error the caller may see: a status, a stable machine code and a safe message."""

    def __init__(
        self,
        status_code: int,
        code: str,
        safe_message: str,
        details: dict[str, object] | None = None,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.safe_message = safe_message
        self.details = details
        super().__init__(safe_message)


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(GatewayError, gateway_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_error_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)


async def gateway_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    if not isinstance(exc, GatewayError):
        raise TypeError("Expected GatewayError")
    return _error_response(
        status_code=exc.status_code,
        code=exc.code,
        message=exc.safe_message,
        details=exc.details,
    )


async def validation_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    if not isinstance(exc, RequestValidationError):
        raise TypeError("Expected RequestValidationError")
    return _error_response(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        code="validation.invalid_request",
        message="Request validation failed.",
        details=_validation_details(exc.errors()),
    )


async def http_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    if not isinstance(exc, StarletteHTTPException):
        raise TypeError("Expected StarletteHTTPException")
    status_code = exc.status_code
    code = "not_found" if status_code == status.HTTP_404_NOT_FOUND else "http_error"
    message = (
        "Resource was not found." if status_code == status.HTTP_404_NOT_FOUND else "Request failed."
    )
    return _error_response(status_code=status_code, code=code, message=message, details=None)


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # Method and path only: the query string and body can carry prompts, transcripts or tokens.
    # The exception text can quote request content, so log the class name and no traceback.
    logger.error(
        "Unhandled request exception: %s",
        type(exc).__name__,
        extra={"path": request.url.path, "method": request.method},
    )
    return _error_response(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        code="internal_error",
        message="Request could not be completed.",
        details=None,
    )


def _error_response(
    *,
    status_code: int,
    code: str,
    message: str,
    details: ErrorDetails,
) -> JSONResponse:
    envelope = ErrorEnvelope(
        code=code,
        message=message,
        details=details,
        trace_id=get_trace_id(),
    )
    return JSONResponse(status_code=status_code, content=envelope.model_dump(mode="json"))


def _format_loc(loc: Sequence[object]) -> str:
    parts = list(loc)
    if parts and parts[0] in {"body", "query", "path", "header"}:
        parts = parts[1:]
    result: list[str] = []
    for part in parts:
        if isinstance(part, int) or (isinstance(part, str) and part.isdigit()):
            result.append(f"[{part}]")
        elif result:
            result.append(f".{part}")
        else:
            result.append(str(part))
    return "".join(result)


def _validation_details(errors: Sequence[dict[str, object]]) -> list[dict[str, object]]:
    # Only where and why a field failed. pydantic's `input` and `ctx` can echo the request body
    # (prompts, transcripts), so neither is passed on.
    details: list[dict[str, object]] = []
    for error in errors:
        loc = list(error.get("loc", ()))
        err_type = str(error.get("type", "value_error"))
        details.append(
            {
                "loc": loc,
                "msg": redact(str(error.get("msg", "Invalid value."))),
                "type": err_type,
                "field": _format_loc(loc),
            }
        )
    return details
