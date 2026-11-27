# No `from __future__ import annotations`: SlowAPI's wrapper has its own module globals, so FastAPI
# could not resolve this endpoint's string annotations.
import json
import logging
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from assistant_gateway import ledger
from assistant_gateway.auth import AppContext, current_app, use_case_of
from assistant_gateway.config import PER_REQUEST, GatewayConfig
from assistant_gateway.db import connect
from assistant_gateway.errors import GatewayError
from assistant_gateway.logging import get_trace_id
from assistant_gateway.pricing import ModelPrice, llm_cost, llm_worst_case
from assistant_gateway.providers import ProviderRejected, ProviderUncertain
from assistant_gateway.providers.llm import LlmProvider, LlmResult
from assistant_gateway.rate_limit import app_rate_limit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/llm", tags=["llm"])


class LlmMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=20_000)


class LlmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    use_case: str = Field(min_length=1)
    end_user_id: str = Field(min_length=1, max_length=128)
    system: str = Field(min_length=1)
    context: str | None = None
    messages: list[LlmMessage] = Field(min_length=1, max_length=40)
    output_schema: dict[str, Any] | None = None
    model: str | None = None


class UsageOut(BaseModel):
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    cache_creation_input_tokens: int


class BudgetOut(BaseModel):
    used_usd: float
    cap_usd: float
    warning: bool


class LlmResponse(BaseModel):
    output: Any
    model: str
    usage: UsageOut
    cost_usd: float
    budget: BudgetOut


def get_llm(request: Request) -> LlmProvider:
    llm: LlmProvider = request.app.state.llm
    return llm


@contextmanager
def _ledger_connection() -> Iterator[psycopg.Connection[Any]]:
    # Opened only once a request has passed validation, and closed again before the provider is
    # called, so nothing is held (no connection, no transaction) while Claude thinks.
    conn = connect(autocommit=True)
    try:
        yield conn
    finally:
        conn.close()


@router.post("/messages", response_model=LlmResponse)
@app_rate_limit
def post_messages(
    request: Request,  # SlowAPI reads the request to key the limit
    body: LlmRequest,
    ctx: Annotated[AppContext, Depends(current_app)],
    llm: Annotated[LlmProvider, Depends(get_llm)],
) -> LlmResponse:
    """One metered Claude call: reserve the worst case, call, then settle what it really cost."""
    case = use_case_of(ctx, body.use_case)
    pricing = _gateway_config(request).pricing
    model = _resolve_model(pricing, case.model, body.model)
    price = pricing[model]

    sent = [body.system, *([body.context] if body.context else []), *map_content(body.messages)]
    if sum(len(part) for part in sent) > case.max_input_chars:
        raise GatewayError(413, "input_too_large", "The request text is too long.")
    input_bytes = sum(len(part.encode("utf-8")) for part in sent)
    if body.output_schema is not None:
        input_bytes += len(json.dumps(body.output_schema).encode("utf-8"))

    outcome = _Outcome(app=ctx.name, use_case=body.use_case, model=model)
    try:
        with _ledger_connection() as conn:
            entry = ledger.reserve(
                conn,
                app=ctx.name,
                use_case=body.use_case,
                end_user_id=body.end_user_id,
                kind="llm",
                model=model,
                amount=llm_worst_case(price, input_bytes, case.max_output_tokens),
                caps=ledger.Caps.for_use_case(ctx.config, case),
                tz=ctx.config.timezone,
            )
    except ledger.BudgetExhausted as exhausted:
        outcome.fail(429, "budget_exhausted")
        raise GatewayError(
            429, "budget_exhausted", "The budget is used up.", details={"cap": exhausted.cap}
        ) from None

    try:
        result = llm.complete(
            model=model,
            system=body.system,
            context=body.context,
            messages=[m.model_dump() for m in body.messages],
            output_schema=body.output_schema,
            max_output_tokens=case.max_output_tokens,
            effort=case.effort,
        )
    except ProviderRejected as rejected:
        _close_entry(entry, "release", rejected.code)
        outcome.fail(502, "provider_unavailable")
        raise _unavailable() from None
    except ProviderUncertain as uncertain:
        # It may have been billed: the reservation keeps counting.
        _close_entry(entry, "mark_unknown", uncertain.code)
        outcome.fail(502, "provider_unavailable")
        raise _unavailable() from None
    except Exception:
        _close_entry(entry, "mark_unknown", "internal_error")
        outcome.fail(500, "internal_error")
        raise

    cost = llm_cost(price, result.usage)
    problem = _output_problem(result, expect_json=body.output_schema is not None)
    with _ledger_connection() as conn:
        ledger.settle(
            conn,
            entry,
            actual_usd=cost,
            usage=result.usage,
            error_code=problem[1] if problem else None,
        )
        snap = ledger.snapshot(
            conn,
            app=ctx.name,
            cap_usd=ctx.config.budget.monthly_cap_usd,
            warn_at=ctx.config.budget.warn_at,
            tz=ctx.config.timezone,
        )
    if problem is not None:
        outcome.fail(502, problem[1], cost)
        raise GatewayError(502, problem[1], problem[0])

    outcome.done(cost)
    return LlmResponse(
        output=json.loads(result.text) if body.output_schema is not None else result.text,
        model=model,
        usage=UsageOut(
            input_tokens=result.usage.input_tokens,
            output_tokens=result.usage.output_tokens,
            cache_read_input_tokens=result.usage.cache_read_input_tokens,
            cache_creation_input_tokens=result.usage.cache_creation_input_tokens,
        ),
        cost_usd=float(cost),
        budget=BudgetOut(
            used_usd=float(snap.used_usd), cap_usd=float(snap.cap_usd), warning=snap.warning
        ),
    )


def map_content(messages: list[LlmMessage]) -> list[str]:
    return [m.content for m in messages]


def _gateway_config(request: Request) -> GatewayConfig:
    config: GatewayConfig = request.app.state.config
    return config


def _resolve_model(
    pricing: Mapping[str, ModelPrice], configured: str, requested: str | None
) -> str:
    """The configured model; on a per-request use case, the requested one (it must be priced)."""
    if configured != PER_REQUEST:
        return configured
    if requested is None:
        raise GatewayError(422, "model_required", "This use case needs a model in the request.")
    if requested not in pricing:
        raise GatewayError(422, "model_not_allowed", "That model is not available.")
    return requested


def _output_problem(result: LlmResult, *, expect_json: bool) -> tuple[str, str] | None:
    """(safe message, code) when a billed call must still be answered 502, else None."""
    if result.stop_reason == "refusal":
        return "The model declined to answer.", "provider_refused"
    if result.stop_reason == "max_tokens":
        return "The answer was cut off.", "provider_bad_output"
    if expect_json:
        try:
            json.loads(result.text)
        except ValueError:
            return "The answer was not valid JSON.", "provider_bad_output"
    return None


def _unavailable() -> GatewayError:
    return GatewayError(502, "provider_unavailable", "The model provider is unavailable.")


def _close_entry(entry: UUID, how: Literal["release", "mark_unknown"], code: str) -> None:
    with _ledger_connection() as conn:
        getattr(ledger, how)(conn, entry, error_code=code)


class _Outcome:
    """One log line per call: identifiers, status, code and cost. Never request or answer text."""

    def __init__(self, *, app: str, use_case: str, model: str) -> None:
        self._fields: dict[str, object] = {"app": app, "use_case": use_case, "model": model}

    def fail(self, status: int, code: str, cost: Decimal | None = None) -> None:
        self._log(status, code, cost)

    def done(self, cost: Decimal) -> None:
        self._log(200, None, cost)

    def _log(self, status: int, code: str | None, cost: Decimal | None) -> None:
        logger.info(
            "llm call",
            extra={
                **self._fields,
                "status": status,
                "error_code": code,
                "cost_usd": float(cost) if cost is not None else None,
                "trace_id": get_trace_id(),
            },
        )
