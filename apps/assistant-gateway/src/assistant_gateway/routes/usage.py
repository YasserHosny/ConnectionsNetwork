# No `from __future__ import annotations`: SlowAPI's wrapper has its own module globals, so FastAPI
# could not resolve this endpoint's string annotations.
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from assistant_gateway import ledger
from assistant_gateway.auth import AppContext, current_app
from assistant_gateway.errors import GatewayError
from assistant_gateway.periods import InvalidPeriod
from assistant_gateway.rate_limit import app_rate_limit
from assistant_gateway.routes.common import ledger_connection

router = APIRouter(prefix="/v1", tags=["usage"])


class UseCaseUsageOut(BaseModel):
    use_case: str
    kind: str
    calls: int
    input_tokens: int
    output_tokens: int
    audio_seconds: float
    settled_usd: float
    reserved_usd: float


class EndUserUsageOut(BaseModel):
    end_user_id: str
    calls: int
    settled_usd: float
    reserved_usd: float


class UsageResponse(BaseModel):
    period: str
    app: str
    settled_usd: float
    reserved_usd: float
    by_use_case: list[UseCaseUsageOut]
    by_end_user: list[EndUserUsageOut]


@router.get("/usage", response_model=UsageResponse)
@app_rate_limit
def get_usage(
    request: Request,  # noqa: ARG001  SlowAPI reads the request to key the limit
    ctx: Annotated[AppContext, Depends(current_app)],
    period: Annotated[str, Query()],
) -> UsageResponse:
    """The calling app's calls, tokens, audio and cost in one month (``YYYY-MM``)."""
    try:
        # Opened here, not as a dependency, so a rate-limited request opens no connection.
        with ledger_connection() as conn:
            report = ledger.usage_report(conn, app=ctx.name, period=period, tz=ctx.config.timezone)
    except InvalidPeriod:
        raise GatewayError(
            422, "invalid_period", "period must be a month written YYYY-MM, e.g. 2026-11."
        ) from None
    return UsageResponse(
        period=report.period,
        app=report.app,
        settled_usd=float(report.settled_usd),
        reserved_usd=float(report.reserved_usd),
        by_use_case=[
            UseCaseUsageOut(
                use_case=row.use_case,
                kind=row.kind,
                calls=row.calls,
                input_tokens=row.input_tokens,
                output_tokens=row.output_tokens,
                audio_seconds=float(row.audio_seconds),
                settled_usd=float(row.settled_usd),
                reserved_usd=float(row.reserved_usd),
            )
            for row in report.by_use_case
        ],
        by_end_user=[
            EndUserUsageOut(
                end_user_id=row.end_user_id,
                calls=row.calls,
                settled_usd=float(row.settled_usd),
                reserved_usd=float(row.reserved_usd),
            )
            for row in report.by_end_user
        ],
    )
