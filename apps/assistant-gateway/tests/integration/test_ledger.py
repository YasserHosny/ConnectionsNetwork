from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg
import pytest

from assistant_gateway import db
from assistant_gateway.ledger import (
    BudgetExhausted,
    BudgetSnapshot,
    Caps,
    LedgerStateError,
    mark_unknown,
    release,
    reserve,
    settle,
    snapshot,
)
from assistant_gateway.pricing import Usage

CAIRO = ZoneInfo("Africa/Cairo")
NOW = datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
ROOMY = Caps(Decimal("100"), None, None)

type Conn = psycopg.Connection[Any]


@pytest.fixture(autouse=True)
def _empty_ledger(database_url: str) -> None:
    with db.connect(database_url, autocommit=True) as c:
        c.execute("truncate assistant_gateway.ledger_entry")


def _reserve(conn: Conn, amount: str, caps: Caps = ROOMY, **overrides: Any) -> UUID:  # noqa: ANN401
    args: dict[str, Any] = {
        "app": "a",
        "use_case": "u",
        "end_user_id": "e",
        "kind": "llm",
        "model": "claude-haiku-4-5",
        "tz": CAIRO,
        "now": NOW,
    }
    args.update(overrides)
    return reserve(conn, amount=Decimal(amount), caps=caps, **args)


def _spent(conn: Conn, amount: str, **overrides: Any) -> UUID:  # noqa: ANN401
    """A settled entry whose actual cost equals its reservation."""
    entry = _reserve(conn, amount, **overrides)
    settle(conn, entry, actual_usd=Decimal(amount))
    return entry


def _snapshot(conn: Conn, cap: str = "1", app: str = "a", now: datetime = NOW) -> BudgetSnapshot:
    return snapshot(conn, app=app, cap_usd=Decimal(cap), warn_at=Decimal("0.8"), tz=CAIRO, now=now)


def _row(conn: Conn, entry: UUID) -> dict[str, Any]:
    cur = conn.execute("select * from assistant_gateway.ledger_entry where id = %s", (entry,))
    names = [d.name for d in cur.description or []]
    row = cur.fetchone()
    assert row is not None
    return dict(zip(names, row, strict=True))


def _status(conn: Conn, entry: UUID) -> str:
    return _row(conn, entry)["status"]


def test_reserve_within_cap_then_settle_counts_actual(conn: Conn) -> None:
    entry = _reserve(conn, "0.05", caps=Caps(Decimal("1"), None, None))
    row = _row(conn, entry)
    assert row["status"] == "reserved"
    assert row["reserved_usd"] == Decimal("0.050000")
    assert row["created_at"] == NOW
    assert (row["app"], row["use_case"], row["end_user_id"], row["kind"], row["model"]) == (
        "a",
        "u",
        "e",
        "llm",
        "claude-haiku-4-5",
    )
    assert _snapshot(conn).used_usd == Decimal("0.050000")

    settle(
        conn,
        entry,
        actual_usd=Decimal("0.01"),
        usage=Usage(
            input_tokens=100,
            output_tokens=20,
            cache_read_input_tokens=3,
            cache_creation_input_tokens=4,
        ),
    )

    assert _snapshot(conn).used_usd == Decimal("0.010000")
    row = _row(conn, entry)
    assert row["status"] == "settled"
    assert row["actual_usd"] == Decimal("0.010000")
    assert (
        row["input_tokens"],
        row["output_tokens"],
        row["cache_read_tokens"],
        row["cache_write_tokens"],
    ) == (100, 20, 3, 4)
    assert row["audio_seconds"] is None
    assert row["settled_at"] is not None


def test_settle_above_the_reservation_logs_a_warning(
    conn: Conn, caplog: pytest.LogCaptureFixture
) -> None:
    entry = _reserve(conn, "0.01")
    with caplog.at_level(logging.WARNING, logger="assistant_gateway.ledger"):
        settle(conn, entry, actual_usd=Decimal("0.02"))
    [record] = [r for r in caplog.records if r.name == "assistant_gateway.ledger"]
    assert record.levelno == logging.WARNING
    assert (record.entry_id, record.app) == (str(entry), "a")
    assert (record.reserved_usd, record.actual_usd) == ("0.010000", "0.020000")
    assert _status(conn, entry) == "settled"


def test_settle_within_the_reservation_does_not_warn(
    conn: Conn, caplog: pytest.LogCaptureFixture
) -> None:
    entry = _reserve(conn, "0.02")
    with caplog.at_level(logging.WARNING, logger="assistant_gateway.ledger"):
        settle(conn, entry, actual_usd=Decimal("0.02"))
    assert [r for r in caplog.records if r.name == "assistant_gateway.ledger"] == []


def test_settle_speech_stores_audio_seconds_and_error_code(conn: Conn) -> None:
    entry = _reserve(conn, "0.02", kind="speech", model="openai")
    settle(
        conn,
        entry,
        actual_usd=Decimal("0.005"),
        audio_seconds=Decimal("12.5"),
        error_code="no_speech",
    )
    row = _row(conn, entry)
    assert row["kind"] == "speech"
    assert row["audio_seconds"] == Decimal("12.50")
    assert row["input_tokens"] is None
    assert row["error_code"] == "no_speech"


def test_reserve_refused_when_app_cap_would_be_exceeded(conn: Conn) -> None:
    _spent(conn, "0.50")
    with pytest.raises(BudgetExhausted) as e:
        _reserve(conn, "0.60", caps=Caps(Decimal("1"), None, None))
    assert e.value.cap == "app_monthly"
    # Refusal writes nothing.
    assert _snapshot(conn).used_usd == Decimal("0.500000")


def test_reserve_exactly_up_to_the_cap_passes(conn: Conn) -> None:
    _spent(conn, "0.50")
    _reserve(conn, "0.50", caps=Caps(Decimal("1"), None, None))
    assert _snapshot(conn).used_usd == Decimal("1.000000")
    with pytest.raises(BudgetExhausted):
        _reserve(conn, "0.000001", caps=Caps(Decimal("1"), None, None))


def test_use_case_cap_is_checked(conn: Conn) -> None:
    caps = Caps(Decimal("10"), Decimal("0.20"), None)
    _spent(conn, "0.15", use_case="u")
    with pytest.raises(BudgetExhausted) as e:
        _reserve(conn, "0.10", caps=caps, use_case="u")
    assert e.value.cap == "use_case_monthly"
    # Another use case's spend is its own.
    _reserve(conn, "0.10", caps=caps, use_case="v")


def test_user_daily_cap_is_checked(conn: Conn) -> None:
    caps = Caps(Decimal("10"), None, Decimal("0.20"))
    _spent(conn, "0.15", end_user_id="e")
    with pytest.raises(BudgetExhausted) as e:
        _reserve(conn, "0.10", caps=caps, end_user_id="e")
    assert e.value.cap == "user_daily"
    # Another user has their own day; the same user gets a new one tomorrow.
    _reserve(conn, "0.10", caps=caps, end_user_id="f")
    _reserve(conn, "0.10", caps=caps, end_user_id="e", now=NOW + timedelta(days=1))


def test_user_daily_cap_counts_every_use_case(conn: Conn) -> None:
    caps = Caps(Decimal("10"), None, Decimal("0.20"))
    _spent(conn, "0.15", use_case="u")
    with pytest.raises(BudgetExhausted) as e:
        _reserve(conn, "0.10", caps=caps, use_case="v")
    assert e.value.cap == "user_daily"


def test_app_cap_is_reported_before_narrower_caps(conn: Conn) -> None:
    caps = Caps(Decimal("0.20"), Decimal("0.20"), Decimal("0.20"))
    _spent(conn, "0.15")
    with pytest.raises(BudgetExhausted) as e:
        _reserve(conn, "0.10", caps=caps)
    assert e.value.cap == "app_monthly"


def test_last_months_spend_does_not_count(conn: Conn) -> None:
    # 21:00 UTC on 30 Nov is 23:00 in Cairo: still November there.
    _spent(conn, "0.90", now=datetime(2026, 11, 30, 21, 0, tzinfo=UTC))
    dec_first = datetime(2026, 11, 30, 22, 30, tzinfo=UTC)  # 00:30 on 1 Dec in Cairo
    _reserve(conn, "0.90", caps=Caps(Decimal("1"), None, None), now=dec_first)
    assert _snapshot(conn, now=dec_first).used_usd == Decimal("0.900000")
    assert _snapshot(conn, now=datetime(2026, 11, 30, 21, 30, tzinfo=UTC)).used_usd == Decimal(
        "0.900000"
    )


def test_released_counts_zero_unknown_counts_reserved(conn: Conn) -> None:
    released = _reserve(conn, "0.30")
    unknown = _reserve(conn, "0.20")
    release(conn, released, error_code="provider_unavailable")
    mark_unknown(conn, unknown, error_code="provider_timeout")

    assert _status(conn, released) == "released"
    assert _row(conn, released)["error_code"] == "provider_unavailable"
    assert _status(conn, unknown) == "unknown"
    assert _row(conn, unknown)["error_code"] == "provider_timeout"
    assert _snapshot(conn).used_usd == Decimal("0.200000")


def test_stale_reservation_expires_and_still_counts(conn: Conn) -> None:
    old = _reserve(conn, "0.30", now=NOW - timedelta(minutes=16))
    recent = _reserve(conn, "0.10", now=NOW - timedelta(minutes=14))
    new = _reserve(conn, "0.20")
    assert _status(conn, old) == "expired"
    assert _status(conn, recent) == "reserved"
    assert _status(conn, new) == "reserved"
    assert _snapshot(conn).used_usd == Decimal("0.600000")


def test_expiry_only_touches_the_reserving_app(conn: Conn) -> None:
    other = _reserve(conn, "0.30", app="b", now=NOW - timedelta(minutes=16))
    _reserve(conn, "0.10", app="a")
    assert _status(conn, other) == "reserved"


def test_late_settle_of_an_expired_entry_records_the_actual(conn: Conn) -> None:
    old = _reserve(conn, "0.30", now=NOW - timedelta(minutes=16))
    _reserve(conn, "0.10")
    assert _status(conn, old) == "expired"
    settle(conn, old, actual_usd=Decimal("0.05"))
    assert _status(conn, old) == "settled"
    assert _snapshot(conn).used_usd == Decimal("0.150000")


def test_expired_entry_can_be_released_or_marked_unknown(conn: Conn) -> None:
    released = _reserve(conn, "0.30", now=NOW - timedelta(minutes=20))
    unknown = _reserve(conn, "0.20", now=NOW - timedelta(minutes=20))
    _reserve(conn, "0.10")
    assert {_status(conn, released), _status(conn, unknown)} == {"expired"}
    release(conn, released, error_code="provider_unavailable")
    mark_unknown(conn, unknown, error_code="provider_timeout")
    assert _status(conn, released) == "released"
    assert _status(conn, unknown) == "unknown"
    assert _snapshot(conn).used_usd == Decimal("0.300000")


def test_closed_entry_cannot_be_settled_again(conn: Conn) -> None:
    entry = _spent(conn, "0.30")
    with pytest.raises(LedgerStateError):
        settle(conn, entry, actual_usd=Decimal("0.01"))
    with pytest.raises(LedgerStateError):
        release(conn, entry, error_code="x")
    with pytest.raises(LedgerStateError):
        mark_unknown(conn, entry, error_code="x")
    row = _row(conn, entry)
    assert (row["status"], row["actual_usd"], row["error_code"]) == (
        "settled",
        Decimal("0.300000"),
        None,
    )


def test_released_and_unknown_entries_cannot_be_settled(conn: Conn) -> None:
    released = _reserve(conn, "0.30")
    release(conn, released, error_code="x")
    unknown = _reserve(conn, "0.20")
    mark_unknown(conn, unknown, error_code="y")
    for entry in (released, unknown):
        with pytest.raises(LedgerStateError):
            settle(conn, entry, actual_usd=Decimal("0.01"))
    assert _snapshot(conn).used_usd == Decimal("0.200000")


def test_unknown_entry_id_is_a_state_error(conn: Conn) -> None:
    with pytest.raises(LedgerStateError):
        settle(conn, UUID(int=0), actual_usd=Decimal("0.01"))


def test_cap_lowered_below_spend(conn: Conn) -> None:
    _spent(conn, "0.50")
    s = _snapshot(conn, cap="0.10")
    assert s == BudgetSnapshot(
        used_usd=Decimal("0.500000"), cap_usd=Decimal("0.10"), warning=True, exhausted=True
    )
    with pytest.raises(BudgetExhausted):
        _reserve(conn, "0.000001", caps=Caps(Decimal("0.10"), None, None))


def test_snapshot_warning_and_exhausted_thresholds(conn: Conn) -> None:
    assert _snapshot(conn) == BudgetSnapshot(Decimal("0"), Decimal("1"), False, False)
    _spent(conn, "0.79")
    assert not _snapshot(conn).warning
    _spent(conn, "0.01")
    s = _snapshot(conn)
    assert s.warning and not s.exhausted
    _spent(conn, "0.20")
    assert _snapshot(conn).exhausted


def test_apps_do_not_share_caps(conn: Conn) -> None:
    caps = Caps(Decimal("1"), None, None)
    _spent(conn, "0.90", app="a")
    _reserve(conn, "0.90", caps=caps, app="b")
    with pytest.raises(BudgetExhausted):
        _reserve(conn, "0.20", caps=caps, app="a")
    assert _snapshot(conn, app="a").used_usd == Decimal("0.900000")
    assert _snapshot(conn, app="b").used_usd == Decimal("0.900000")


def test_amount_is_rounded_up_to_six_places(conn: Conn) -> None:
    entry = _reserve(conn, "0.0000001")
    assert _row(conn, entry)["reserved_usd"] == Decimal("0.000001")
    settle(conn, entry, actual_usd=Decimal("0.0000001"))
    assert _row(conn, entry)["actual_usd"] == Decimal("0.000001")


def test_negative_amounts_are_rejected(conn: Conn) -> None:
    with pytest.raises(ValueError, match="negative"):
        _reserve(conn, "-0.01")
    entry = _reserve(conn, "0.01")
    with pytest.raises(ValueError, match="negative"):
        settle(conn, entry, actual_usd=Decimal("-0.01"))


def test_naive_now_is_rejected(conn: Conn) -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        _reserve(conn, "0.01", now=datetime(2026, 11, 15, 12, 0))


def test_ledger_requires_an_autocommit_connection(database_url: str, conn: Conn) -> None:
    entry = _reserve(conn, "0.01")
    with db.connect(database_url) as manual:
        with pytest.raises(ValueError, match="autocommit"):
            _reserve(manual, "0.01")
        for call in (
            lambda: settle(manual, entry, actual_usd=Decimal("0.01")),
            lambda: release(manual, entry, error_code="x"),
            lambda: mark_unknown(manual, entry, error_code="x"),
        ):
            with pytest.raises(ValueError, match="autocommit"):
                call()


@pytest.mark.parametrize("isolation", ["read committed", "repeatable read", "serializable"])
def test_concurrent_reservations_never_exceed_cap(
    database_url: str, conn: Conn, isolation: str
) -> None:
    # The cap must hold whatever default isolation the session has: under repeatable read a
    # snapshot taken before the lock was granted would miss reservations committed while waiting.
    options = f"-c default_transaction_isolation={isolation.replace(' ', chr(92) + ' ')}"
    workers = 20
    caps = Caps(Decimal("1.00"), None, None)
    barrier = threading.Barrier(workers, timeout=30)
    outcomes: list[str] = []
    lock = threading.Lock()

    def worker(index: int) -> None:
        try:
            with db.connect(database_url, autocommit=True, options=options) as own:
                barrier.wait()
                try:
                    _reserve(own, "0.10", caps=caps, end_user_id=f"user-{index}")
                    outcome = "ok"
                except BudgetExhausted as exc:
                    outcome = exc.cap
        except Exception as exc:  # surfaced through the assertion below
            outcome = f"error: {exc!r}"
        with lock:
            outcomes.append(outcome)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert sorted(outcomes) == sorted(["ok"] * 10 + ["app_monthly"] * 10)
    total = conn.execute(
        "select coalesce(sum(reserved_usd), 0) from assistant_gateway.ledger_entry "
        "where app = 'a' and status = 'reserved'"
    ).fetchone()
    assert total is not None and total[0] == Decimal("1.000000")
