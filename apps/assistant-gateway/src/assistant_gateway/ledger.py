"""The spending ledger: reserve a worst case before a provider call, then settle or release it.

Spend in a window is ``sum(actual_usd)`` over settled entries plus ``sum(reserved_usd)`` over
reserved, expired and unknown entries; released entries count nothing. Windows are the calendar
month and day in the app's timezone (`periods`), matched on ``created_at``.

`reserve` serialises per app with a transaction-scoped advisory lock, so concurrent requests
cannot overshoot a cap together. It forces read committed first, so the guarantee does not depend
on the session's default isolation level. The lock is ``pg_advisory_xact_lock``, which is safe
behind Supabase's transaction pooler because it is released when the transaction ends.

**Connections must be in autocommit mode.** Every function here opens and owns its transaction
with ``conn.transaction()``. On a connection that is not autocommit, psycopg may already hold an
implicit transaction; ``conn.transaction()`` would then be a savepoint, the advisory lock would
outlive `reserve`, and the reservation would be invisible to other requests until the caller
commits. Each function raises `ValueError` on a non-autocommit connection rather than risk that.

`settle`, `release` and `mark_unknown` close an open entry: one that is ``reserved``, or
``expired`` because a slow call outlived the 15-minute sweep (the caller knows the real outcome,
which is more accurate than the sweep's guess). Closing an entry that is already settled,
released or unknown raises `LedgerStateError` and changes nothing, so no cost is counted twice.
These single-row updates take no lock: a reserve running alongside sees either the old or the
new amount, and since the reservation is a worst-case upper bound (`pricing.llm_worst_case`),
closing an entry can only lower counted spend.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_CEILING, Decimal
from typing import Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg

from assistant_gateway.config import AppConfig, UseCaseConfig
from assistant_gateway.periods import day_window, month_window, period_window
from assistant_gateway.pricing import Usage

logger = logging.getLogger(__name__)

type CapName = Literal["app_monthly", "use_case_monthly", "user_daily"]

STALE_AFTER = timedelta(minutes=15)

_QUANTUM = Decimal("0.000001")
_OPEN = ("reserved", "expired")

_LOCK = "select pg_advisory_xact_lock(hashtextextended('assistant_gateway:app:' || %s, 0))"

_EXPIRE = """
update assistant_gateway.ledger_entry
   set status = 'expired'
 where app = %(app)s and status = 'reserved' and created_at < %(stale_before)s
"""

# The spend rule, in one place: what an entry counts towards a cap. Settled entries count their
# actual cost; released entries nothing; reserved, expired and unknown ones their reservation.
_COST = """case status
               when 'settled' then coalesce(actual_usd, reserved_usd)
               when 'released' then 0
               else reserved_usd
           end"""

# One select for all three windows. The day window always lies inside the month window, so the
# month bounds limit the rows scanned.
_SPEND = f"""
with entries as (
    select use_case, end_user_id, created_at, {_COST} as cost
      from assistant_gateway.ledger_entry
     where app = %(app)s and created_at >= %(month_start)s and created_at < %(month_end)s
)
select coalesce(sum(cost), 0),
       coalesce(sum(cost) filter (where use_case = %(use_case)s), 0),
       coalesce(sum(cost) filter (
           where end_user_id = %(end_user_id)s
             and created_at >= %(day_start)s and created_at < %(day_end)s
       ), 0)
  from entries
"""

_APP_MONTH_SPEND = f"""
select coalesce(sum({_COST}), 0)
  from assistant_gateway.ledger_entry
 where app = %(app)s and created_at >= %(start)s and created_at < %(end)s
"""

# The usage report splits the same cost into its settled part and its still-reserved part.
_SETTLED_USD = f"coalesce(sum({_COST}) filter (where status = 'settled'), 0)"
_RESERVED_USD = (
    f"coalesce(sum({_COST}) filter (where status in ('reserved', 'expired', 'unknown')), 0)"
)

_USAGE_TOTALS = f"""
select {_SETTLED_USD}, {_RESERVED_USD}
  from assistant_gateway.ledger_entry
 where app = %(app)s and created_at >= %(start)s and created_at < %(end)s
"""

_USAGE_BY_USE_CASE = f"""
select use_case, kind, count(*),
       coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0),
       coalesce(sum(audio_seconds), 0), {_SETTLED_USD}, {_RESERVED_USD}
  from assistant_gateway.ledger_entry
 where app = %(app)s and created_at >= %(start)s and created_at < %(end)s
 group by use_case, kind
 order by use_case, kind
"""

_USAGE_BY_END_USER = f"""
select end_user_id, count(*), {_SETTLED_USD}, {_RESERVED_USD}
  from assistant_gateway.ledger_entry
 where app = %(app)s and created_at >= %(start)s and created_at < %(end)s
 group by end_user_id
 order by end_user_id
"""

_INSERT = """
insert into assistant_gateway.ledger_entry
    (app, use_case, end_user_id, kind, model, status, reserved_usd, created_at)
values (%(app)s, %(use_case)s, %(end_user_id)s, %(kind)s, %(model)s, 'reserved', %(amount)s,
        %(now)s)
returning id
"""


class BudgetExhausted(Exception):
    """A reservation would take spend past `cap`."""

    def __init__(self, cap: CapName) -> None:
        super().__init__(f"budget exhausted: {cap}")
        self.cap: CapName = cap


class LedgerStateError(Exception):
    """The entry does not exist or is already closed (settled, released or unknown)."""


@dataclass(frozen=True)
class Caps:
    app_monthly: Decimal
    use_case_monthly: Decimal | None
    user_daily: Decimal | None

    @classmethod
    def for_use_case(cls, app: AppConfig, use_case: UseCaseConfig) -> Caps:
        return cls(
            app_monthly=app.budget.monthly_cap_usd,
            use_case_monthly=use_case.cap_usd,
            user_daily=app.budget.per_user_daily_cap_usd,
        )


@dataclass(frozen=True)
class BudgetSnapshot:
    used_usd: Decimal
    cap_usd: Decimal
    warning: bool
    exhausted: bool


@dataclass(frozen=True)
class UseCaseUsage:
    use_case: str
    kind: str
    calls: int
    input_tokens: int
    output_tokens: int
    audio_seconds: Decimal
    settled_usd: Decimal
    reserved_usd: Decimal


@dataclass(frozen=True)
class EndUserUsage:
    end_user_id: str
    calls: int
    settled_usd: Decimal
    reserved_usd: Decimal


@dataclass(frozen=True)
class UsageReport:
    period: str
    app: str
    settled_usd: Decimal
    reserved_usd: Decimal
    by_use_case: list[UseCaseUsage]
    by_end_user: list[EndUserUsage]


def reserve(
    conn: psycopg.Connection[Any],
    *,
    app: str,
    use_case: str,
    end_user_id: str,
    kind: Literal["llm", "speech"],
    model: str,
    amount: Decimal,
    caps: Caps,
    tz: ZoneInfo,
    now: datetime | None = None,
) -> UUID:
    """Reserve `amount` (rounded up to 6 places) or raise `BudgetExhausted` naming the cap.

    A cap passes when spend in its window plus `amount` is at most the cap. Caps are checked
    app month first, then use-case month, then user day.
    """
    _require_autocommit(conn)
    amount = _money(amount)
    now = _now(now)
    month_start, month_end = month_window(now, tz)
    day_start, day_end = day_window(now, tz)
    with conn.transaction():
        # Read committed, whatever the session default: under repeatable read or serializable the
        # snapshot is taken at the first statement, before the lock is granted, and the spend query
        # would miss reservations committed while waiting. This must stay the first statement.
        conn.execute("set transaction isolation level read committed")
        conn.execute(_LOCK, (app,))
        conn.execute(_EXPIRE, {"app": app, "stale_before": now - STALE_AFTER})
        row = conn.execute(
            _SPEND,
            {
                "app": app,
                "use_case": use_case,
                "end_user_id": end_user_id,
                "month_start": month_start,
                "month_end": month_end,
                "day_start": day_start,
                "day_end": day_end,
            },
        ).fetchone()
        assert row is not None
        app_spend, use_case_spend, user_spend = row
        checks: tuple[tuple[CapName, Decimal, Decimal | None], ...] = (
            ("app_monthly", app_spend, caps.app_monthly),
            ("use_case_monthly", use_case_spend, caps.use_case_monthly),
            ("user_daily", user_spend, caps.user_daily),
        )
        for name, spend, cap in checks:
            if cap is not None and spend + amount > cap:
                raise BudgetExhausted(name)
        inserted = conn.execute(
            _INSERT,
            {
                "app": app,
                "use_case": use_case,
                "end_user_id": end_user_id,
                "kind": kind,
                "model": model,
                "amount": amount,
                "now": now,
            },
        ).fetchone()
        assert inserted is not None
        return inserted[0]


def settle(
    conn: psycopg.Connection[Any],
    entry_id: UUID,
    *,
    actual_usd: Decimal,
    usage: Usage | None = None,
    audio_seconds: Decimal | None = None,
    error_code: str | None = None,
) -> None:
    """Record the actual cost (rounded up) of an open entry, with its token or audio usage."""
    _require_autocommit(conn)
    actual = _money(actual_usd)
    row = _close(
        conn,
        entry_id,
        """
        update assistant_gateway.ledger_entry
           set status = 'settled', actual_usd = %(actual)s,
               input_tokens = %(input)s, output_tokens = %(output)s,
               cache_read_tokens = %(cache_read)s, cache_write_tokens = %(cache_write)s,
               audio_seconds = %(audio_seconds)s, error_code = %(error_code)s,
               settled_at = %(now)s
         where id = %(id)s and status = any(%(open)s)
        returning id, app, reserved_usd
        """,
        {
            "actual": actual,
            "input": usage.input_tokens if usage else None,
            "output": usage.output_tokens if usage else None,
            "cache_read": usage.cache_read_input_tokens if usage else None,
            "cache_write": usage.cache_creation_input_tokens if usage else None,
            "audio_seconds": audio_seconds,
            "error_code": error_code,
            "now": datetime.now(UTC),
        },
    )
    _, app, reserved = row
    if actual > reserved:
        # The worst case was meant to be an upper bound: a pricing or estimate bug if it is not.
        # Ids and amounts only, never request content.
        logger.warning(
            "Settled above the reservation",
            extra={
                "entry_id": str(entry_id),
                "app": app,
                "reserved_usd": str(reserved),
                "actual_usd": str(actual),
            },
        )


def release(conn: psycopg.Connection[Any], entry_id: UUID, *, error_code: str) -> None:
    """The call failed before anything was billed: the entry stops counting."""
    _require_autocommit(conn)
    _close(conn, entry_id, _set_status("released"), {"error_code": error_code})


def mark_unknown(conn: psycopg.Connection[Any], entry_id: UUID, *, error_code: str) -> None:
    """The call's outcome is unknown (e.g. a timeout): the entry keeps counting `reserved_usd`."""
    _require_autocommit(conn)
    _close(conn, entry_id, _set_status("unknown"), {"error_code": error_code})


def snapshot(
    conn: psycopg.Connection[Any],
    *,
    app: str,
    cap_usd: Decimal,
    warn_at: Decimal,
    tz: ZoneInfo,
    now: datetime | None = None,
) -> BudgetSnapshot:
    """The app's spend this month against `cap_usd`."""
    start, end = month_window(_now(now), tz)
    row = conn.execute(_APP_MONTH_SPEND, {"app": app, "start": start, "end": end}).fetchone()
    assert row is not None
    used: Decimal = row[0]
    return BudgetSnapshot(
        used_usd=used,
        cap_usd=cap_usd,
        warning=used >= warn_at * cap_usd,
        exhausted=used >= cap_usd,
    )


def usage_report(
    conn: psycopg.Connection[Any], *, app: str, period: str, tz: ZoneInfo
) -> UsageReport:
    """The app's calls, tokens, audio and cost in `period` (``YYYY-MM``, a month in `tz`).

    `settled_usd` is what settled calls cost; `reserved_usd` is what reserved, expired and unknown
    calls still hold. Released calls are counted in `calls` and cost nothing. Raises
    `periods.InvalidPeriod` when `period` is not ``YYYY-MM``.

    The three queries run in one repeatable-read transaction, so the totals and both breakdowns
    describe the same moment.
    """
    _require_autocommit(conn)
    start, end = period_window(period, tz)
    params = {"app": app, "start": start, "end": end}
    with conn.transaction():
        conn.execute("set transaction isolation level repeatable read read only")
        totals = conn.execute(_USAGE_TOTALS, params).fetchone()
        by_use_case = conn.execute(_USAGE_BY_USE_CASE, params).fetchall()
        by_end_user = conn.execute(_USAGE_BY_END_USER, params).fetchall()
    assert totals is not None
    return UsageReport(
        period=period,
        app=app,
        settled_usd=totals[0],
        reserved_usd=totals[1],
        by_use_case=[UseCaseUsage(*row) for row in by_use_case],
        by_end_user=[EndUserUsage(*row) for row in by_end_user],
    )


def _set_status(status: Literal["released", "unknown"]) -> str:
    return f"""
        update assistant_gateway.ledger_entry
           set status = '{status}', error_code = %(error_code)s
         where id = %(id)s and status = any(%(open)s)
        returning id
        """


def _close(
    conn: psycopg.Connection[Any], entry_id: UUID, sql: str, params: dict[str, object]
) -> tuple[Any, ...]:
    with conn.transaction():
        row = conn.execute(sql, {**params, "id": entry_id, "open": list(_OPEN)}).fetchone()
    if row is None:
        raise LedgerStateError(f"ledger entry {entry_id} is missing or already closed")
    return row


def _require_autocommit(conn: psycopg.Connection[Any]) -> None:
    if not conn.autocommit:
        raise ValueError("the ledger needs an autocommit connection: it owns its transactions")


def _money(amount: Decimal) -> Decimal:
    if not amount.is_finite() or amount < 0:
        raise ValueError("amount must be a finite, non-negative Decimal")
    return amount.quantize(_QUANTUM, rounding=ROUND_CEILING)


def _now(now: datetime | None) -> datetime:
    if now is None:
        return datetime.now(UTC)
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    return now
