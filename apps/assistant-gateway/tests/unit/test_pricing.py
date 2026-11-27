from __future__ import annotations

from decimal import Decimal

from assistant_gateway.pricing import (
    INPUT_OVERHEAD_TOKENS,
    ModelPrice,
    Usage,
    llm_cost,
    llm_worst_case,
    speech_cost,
)

HAIKU = ModelPrice(Decimal("1"), Decimal("5"), Decimal("1.25"), Decimal("0.10"))


def test_llm_cost_prices_each_token_kind() -> None:
    u = Usage(
        input_tokens=1000,
        output_tokens=200,
        cache_read_input_tokens=3000,
        cache_creation_input_tokens=500,
    )
    assert llm_cost(HAIKU, u) == Decimal("0.002925")  # .001 + .001 + .0003 + .000625


def test_worst_case_uses_dearer_input_rate_and_overhead() -> None:
    assert INPUT_OVERHEAD_TOKENS == 4096
    assert llm_worst_case(HAIKU, input_bytes=10_000, max_output_tokens=2000) == Decimal("0.027620")


def test_worst_case_uses_uncached_rate_when_it_is_dearer() -> None:
    price = ModelPrice(Decimal("3"), Decimal("15"), Decimal("1"), Decimal("0.3"))
    # (0 + 4096) * 3 / 1e6 = 0.012288
    assert llm_worst_case(price, input_bytes=0, max_output_tokens=0) == Decimal("0.012288")


def test_worst_case_uses_cache_read_rate_when_it_is_dearest() -> None:
    price = ModelPrice(Decimal("1"), Decimal("5"), Decimal("1.25"), Decimal("2"))
    # (0 + 4096) * 2 / 1e6 = 0.008192
    assert llm_worst_case(price, input_bytes=0, max_output_tokens=0) == Decimal("0.008192")


def test_worst_case_counts_bytes_not_characters() -> None:
    arabic = "مهندس برمجيات" * 100
    assert llm_worst_case(HAIKU, len(arabic.encode()), 0) > llm_worst_case(HAIKU, len(arabic), 0)


def test_worst_case_bounds_actual_cost_when_all_input_is_cache_write() -> None:
    usage = Usage(input_tokens=0, output_tokens=2000, cache_creation_input_tokens=10_000 + 4096)
    assert llm_cost(HAIKU, usage) <= llm_worst_case(HAIKU, 10_000, 2000)


def test_costs_round_up() -> None:
    assert speech_cost(Decimal("0.006"), Decimal("0.5")) == Decimal("0.000050")
    assert llm_cost(HAIKU, Usage(1, 0)) == Decimal("0.000001")


def test_fractional_remainders_round_up_not_to_nearest() -> None:
    # 0.1e-6 -> 0.000001 (down would give 0)
    assert llm_cost(HAIKU, Usage(0, 0, cache_read_input_tokens=1)) == Decimal("0.000001")
    # 0.00011666... -> 0.000117
    assert speech_cost(Decimal("0.007"), Decimal("1")) == Decimal("0.000117")
    # 4097 * 0.3 / 1e6 = 0.0012291 -> 0.001230 (half-even/half-up would give 0.001229)
    price = ModelPrice(Decimal("0.3"), Decimal("0.1"), Decimal("0.1"), Decimal("0.1"))
    assert llm_worst_case(price, input_bytes=1, max_output_tokens=0) == Decimal("0.001230")
    # 0.0000004 -> 0.000001 for a tiny remainder (nearest would give 0)
    assert llm_cost(HAIKU, Usage(0, 0, cache_read_input_tokens=4)) == Decimal("0.000001")


def test_zero_usage_costs_nothing() -> None:
    assert llm_cost(HAIKU, Usage(0, 0)) == Decimal("0.000000")
    assert speech_cost(Decimal("0.006"), Decimal("0")) == Decimal("0.000000")
