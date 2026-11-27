from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal

INPUT_OVERHEAD_TOKENS = 4096

_PER_MILLION = Decimal(1_000_000)
_QUANTUM = Decimal("0.000001")


@dataclass(frozen=True)
class ModelPrice:
    """USD per million tokens."""

    input: Decimal
    output: Decimal
    cache_write: Decimal
    cache_read: Decimal


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0


def _round_up(amount: Decimal) -> Decimal:
    return amount.quantize(_QUANTUM, rounding=ROUND_CEILING)


def llm_cost(price: ModelPrice, usage: Usage) -> Decimal:
    """Actual cost of a provider call, rounded up to 6 decimal places."""
    total = (
        usage.input_tokens * price.input
        + usage.output_tokens * price.output
        + usage.cache_read_input_tokens * price.cache_read
        + usage.cache_creation_input_tokens * price.cache_write
    )
    return _round_up(total / _PER_MILLION)


def llm_worst_case(price: ModelPrice, input_bytes: int, max_output_tokens: int) -> Decimal:
    """Upper bound on a call's cost, reserved before the call is made.

    Every input token (one per UTF-8 byte, plus a fixed overhead) is priced at the dearer of
    uncached input and cache write, so no cache outcome can exceed it.
    """
    input_rate = max(price.input, price.cache_write)
    total = (input_bytes + INPUT_OVERHEAD_TOKENS) * input_rate + max_output_tokens * price.output
    return _round_up(total / _PER_MILLION)


def speech_cost(per_minute: Decimal, seconds: Decimal) -> Decimal:
    """Cost of transcribing `seconds` of audio, rounded up to 6 decimal places."""
    return _round_up(per_minute * seconds / Decimal(60))
