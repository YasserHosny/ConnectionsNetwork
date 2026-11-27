from __future__ import annotations

from decimal import Decimal
from zoneinfo import ZoneInfo

from assistant_gateway.config import AppConfig, BudgetConfig, UseCaseConfig
from assistant_gateway.ledger import BudgetExhausted, Caps


def _app(per_user_daily: Decimal | None) -> AppConfig:
    return AppConfig(
        key_hash="0" * 64,
        timezone=ZoneInfo("Africa/Cairo"),
        budget=BudgetConfig(
            monthly_cap_usd=Decimal("20"),
            per_user_daily_cap_usd=per_user_daily,
            warn_at=Decimal("0.8"),
        ),
        use_cases={},
    )


def test_caps_for_use_case_takes_every_cap() -> None:
    case = UseCaseConfig(model="claude-haiku-4-5", max_output_tokens=1024, cap_usd=Decimal("5"))
    caps = Caps.for_use_case(_app(Decimal("0.5")), case)
    assert caps == Caps(
        app_monthly=Decimal("20"), use_case_monthly=Decimal("5"), user_daily=Decimal("0.5")
    )


def test_caps_for_use_case_keeps_optional_caps_absent() -> None:
    case = UseCaseConfig(model="claude-haiku-4-5", max_output_tokens=1024)
    assert Caps.for_use_case(_app(None), case) == Caps(Decimal("20"), None, None)


def test_budget_exhausted_names_the_cap() -> None:
    exc = BudgetExhausted("user_daily")
    assert exc.cap == "user_daily"
    assert "user_daily" in str(exc)
