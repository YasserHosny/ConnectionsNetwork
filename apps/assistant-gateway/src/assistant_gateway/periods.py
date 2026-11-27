"""Budget periods: the calendar month and calendar day in an app's own timezone.

Each window is half-open, ``[start, end)``, with both bounds converted to UTC so they compare
directly with ``timestamptz`` columns. A local midnight that a DST change skips resolves to the
transition instant (zoneinfo's ``fold=0``), so consecutive windows always meet exactly.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo


def _local_midnight(day: date, tz: ZoneInfo) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=tz).astimezone(UTC)


def _local_date(now: datetime, tz: ZoneInfo) -> date:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    return now.astimezone(tz).date()


def _month_bounds(first: date, tz: ZoneInfo) -> tuple[datetime, datetime]:
    following = (
        date(first.year + 1, 1, 1) if first.month == 12 else first.replace(month=first.month + 1)
    )
    return _local_midnight(first, tz), _local_midnight(following, tz)


def month_window(now: datetime, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """UTC bounds of the calendar month in `tz` that contains `now`."""
    return _month_bounds(_local_date(now, tz).replace(day=1), tz)


class InvalidPeriod(ValueError):
    """A period that is not ``YYYY-MM`` with a real month."""


# ASCII digits only: `\d` would also accept other scripts' digits.
_PERIOD = re.compile(r"([0-9]{4})-([0-9]{2})")


def period_window(period: str, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """UTC bounds of the calendar month in `tz` named by `period` (``YYYY-MM``)."""
    match = _PERIOD.fullmatch(period)
    if match is None:
        raise InvalidPeriod("period must look like YYYY-MM")
    try:
        first = date(int(match[1]), int(match[2]), 1)
    except ValueError:  # year 0000 or month 00 / 13+
        raise InvalidPeriod("period must look like YYYY-MM") from None
    try:
        return _month_bounds(first, tz)
    except (ValueError, OverflowError):
        # 9999-12 ends in year 10000, which `date` cannot hold; 0001-01 east of UTC starts
        # before the earliest UTC instant.
        raise InvalidPeriod("period is outside the representable months") from None


def day_window(now: datetime, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """UTC bounds of the calendar day in `tz` that contains `now`."""
    today = _local_date(now, tz)
    return _local_midnight(today, tz), _local_midnight(today + timedelta(days=1), tz)
