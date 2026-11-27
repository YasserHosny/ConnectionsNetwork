# No `from __future__ import annotations`: SlowAPI's wrapper has its own module globals, so FastAPI
# could not resolve this endpoint's string annotations.
import logging
from collections.abc import Mapping
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from pydantic import BaseModel

from assistant_gateway import ledger
from assistant_gateway.audio import UnsupportedAudio, duration_seconds
from assistant_gateway.auth import AppContext, current_app, use_case_of
from assistant_gateway.body_limit import MAX_AUDIO_BYTES
from assistant_gateway.config import PER_REQUEST, GatewayConfig, UseCaseConfig
from assistant_gateway.errors import GatewayError
from assistant_gateway.logging import get_trace_id
from assistant_gateway.pricing import speech_cost
from assistant_gateway.providers import ProviderRejected, ProviderUncertain
from assistant_gateway.providers.speech import SpeechProvider
from assistant_gateway.rate_limit import app_rate_limit
from assistant_gateway.routes.common import (
    BudgetOut,
    EndUserId,
    close_entry,
    gateway_config,
    ledger_connection,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/speech", tags=["speech"])

# The whole request is capped before it is parsed (body_limit); this is the file's own cap.
MAX_UPLOAD_BYTES = MAX_AUDIO_BYTES


class SpeechResponse(BaseModel):
    text: str
    duration_seconds: float
    provider: str
    cost_usd: float
    budget: BudgetOut


def get_speech(request: Request) -> Mapping[str, SpeechProvider]:
    speech: Mapping[str, SpeechProvider] = request.app.state.speech
    return speech


@router.post("/transcribe", response_model=SpeechResponse)
@app_rate_limit
def post_transcribe(
    request: Request,  # SlowAPI reads the request to key the limit
    file: Annotated[UploadFile, File()],
    use_case: Annotated[str, Form(min_length=1)],
    end_user_id: Annotated[EndUserId, Form()],
    ctx: Annotated[AppContext, Depends(current_app)],
    registry: Annotated[Mapping[str, SpeechProvider], Depends(get_speech)],
    language: Annotated[str | None, Form()] = None,
    provider: Annotated[str | None, Form()] = None,
) -> SpeechResponse:
    """One metered transcription: reserve the price of the measured length, call, then settle."""
    case = use_case_of(ctx, use_case)
    if case.speech.mode != "server":
        raise GatewayError(409, "speech_mode_browser", "This use case uses browser speech.")
    config = gateway_config(request)
    key, speaker = _resolve_provider(config, registry, case, provider)
    price = config.speech_pricing[key]

    # Read one byte past the cap, so an oversized upload is noticed without holding all of it.
    audio = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(audio) > MAX_UPLOAD_BYTES:
        raise GatewayError(413, "audio_too_large", "The recording is too large.")
    try:
        # The limit stops the measuring early: a crafted file can hold hours of audio in 10 MB.
        seconds = duration_seconds(audio, limit=Decimal(case.max_audio_seconds))
    except UnsupportedAudio:
        raise GatewayError(415, "unsupported_audio", "The recording is not supported.") from None
    if seconds > case.max_audio_seconds:
        raise GatewayError(413, "audio_too_long", "The recording is too long.")

    amount = speech_cost(price, seconds)
    outcome = _Outcome(app=ctx.name, use_case=use_case, provider=key)
    try:
        with ledger_connection() as conn:
            entry = ledger.reserve(
                conn,
                app=ctx.name,
                use_case=use_case,
                end_user_id=end_user_id,
                kind="speech",
                model=key,
                amount=amount,
                caps=ledger.Caps.for_use_case(ctx.config, case),
                tz=ctx.config.timezone,
            )
    except ledger.BudgetExhausted as exhausted:
        outcome.fail(429, "budget_exhausted")
        raise GatewayError(
            429, "budget_exhausted", "The budget is used up.", details={"cap": exhausted.cap}
        ) from None

    try:
        result = speaker.transcribe(
            audio, file.content_type or "application/octet-stream", language or case.speech.language
        )
    except ProviderRejected as rejected:
        close_entry(entry, "release", rejected.code)
        outcome.fail(502, "provider_unavailable")
        raise _unavailable() from None
    except ProviderUncertain as uncertain:
        # It may have been billed: the reservation keeps counting.
        close_entry(entry, "mark_unknown", uncertain.code)
        outcome.fail(502, "provider_unavailable")
        raise _unavailable() from None
    except Exception:
        close_entry(entry, "mark_unknown", "internal_error")
        outcome.fail(500, "internal_error")
        raise

    # Priced by the measured length, so the settled amount is the reserved one.
    with ledger_connection() as conn:
        ledger.settle(conn, entry, actual_usd=amount, audio_seconds=seconds)
        snap = ledger.snapshot(
            conn,
            app=ctx.name,
            cap_usd=ctx.config.budget.monthly_cap_usd,
            warn_at=ctx.config.budget.warn_at,
            tz=ctx.config.timezone,
        )
    outcome.done(amount)
    return SpeechResponse(
        text=result.text,
        duration_seconds=float(seconds),
        provider=key,
        cost_usd=float(amount),
        budget=BudgetOut(
            used_usd=float(snap.used_usd), cap_usd=float(snap.cap_usd), warning=snap.warning
        ),
    )


def _resolve_provider(
    config: GatewayConfig,
    registry: Mapping[str, SpeechProvider],
    case: UseCaseConfig,
    requested: str | None,
) -> tuple[str, SpeechProvider]:
    """(registry key, adapter) for the use case's provider; on a per-request one, the requested.

    The key, not the adapter's own `name`, prices the call and labels the ledger and response.
    """
    configured = case.speech.provider
    if configured != PER_REQUEST:
        found = registry.get(configured or "")
        if found is None:
            # Priced and configured (the config says so), but no adapter exists for it.
            raise _unavailable()
        return configured or "", found
    if not requested:
        raise GatewayError(422, "provider_required", "This use case needs a provider.")
    found = registry.get(requested)
    if (
        found is None
        or requested not in config.speech_pricing
        or config.providers.get(requested) is None
    ):
        raise GatewayError(422, "provider_not_allowed", "That provider is not available.")
    return requested, found


def _unavailable() -> GatewayError:
    return GatewayError(502, "provider_unavailable", "The speech provider is unavailable.")


class _Outcome:
    """One log line per call: identifiers, status, code and cost. Never a transcript or audio."""

    def __init__(self, *, app: str, use_case: str, provider: str) -> None:
        self._fields: dict[str, object] = {"app": app, "use_case": use_case, "provider": provider}

    def fail(self, status: int, code: str) -> None:
        self._log(status, code, None)

    def done(self, cost: Decimal) -> None:
        self._log(200, None, cost)

    def _log(self, status: int, code: str | None, cost: Decimal | None) -> None:
        logger.info(
            "speech call",
            extra={
                **self._fields,
                "status": status,
                "error_code": code,
                "cost_usd": float(cost) if cost is not None else None,
                "trace_id": get_trace_id(),
            },
        )
