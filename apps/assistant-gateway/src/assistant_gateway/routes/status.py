# No `from __future__ import annotations`: SlowAPI's wrapper has its own module globals, so FastAPI
# could not resolve this endpoint's string annotations.
from typing import Annotated, Any

import psycopg
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from assistant_gateway import ledger
from assistant_gateway.auth import AppContext, current_app, use_case_of
from assistant_gateway.db import request_connection
from assistant_gateway.rate_limit import app_rate_limit

router = APIRouter(prefix="/v1", tags=["status"])


class SpeechStatus(BaseModel):
    mode: str
    language: str | None


class BudgetStatus(BaseModel):
    used_usd: float
    cap_usd: float
    warning: bool
    exhausted: bool


class StatusResponse(BaseModel):
    speech: SpeechStatus
    available: bool
    budget: BudgetStatus


@router.get("/status", response_model=StatusResponse)
@app_rate_limit
def get_status(
    request: Request,  # noqa: ARG001  SlowAPI reads the request to key the limit
    ctx: Annotated[AppContext, Depends(current_app)],
    conn: Annotated[psycopg.Connection[Any], Depends(request_connection)],
    use_case: Annotated[str, Query(min_length=1)],
    end_user_id: Annotated[str, Query(min_length=1, max_length=128)],  # noqa: ARG001
) -> StatusResponse:
    """What an app may expect now: the use case's speech mode and the app's monthly budget."""
    case = use_case_of(ctx, use_case)
    budget = ctx.config.budget
    snap = ledger.snapshot(
        conn,
        app=ctx.name,
        cap_usd=budget.monthly_cap_usd,
        warn_at=budget.warn_at,
        tz=ctx.config.timezone,
    )
    return StatusResponse(
        speech=SpeechStatus(mode=case.speech.mode, language=case.speech.language),
        available=not snap.exhausted,
        budget=BudgetStatus(
            used_usd=float(snap.used_usd),
            cap_usd=float(snap.cap_usd),
            warning=snap.warning,
            exhausted=snap.exhausted,
        ),
    )
