"""Budget periods: the calendar month and calendar day in an app's own timezone.

Each window is half-open, ``[start, end)``, with both bounds converted to UTC so they compare
directly with ``timestamptz`` columns. A local midnight that a DST change skips resolves to the
transition instant (zoneinfo's ``fold=0``), so consecutive windows always meet exactly.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo


def _local_midnight(day: date, tz: ZoneInfo) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=tz).astimezone(UTC)


def _local_date(now: datetime, tz: ZoneInfo) -> date:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    return now.astimezone(tz).date()


def month_window(now: datetime, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """UTC bounds of the calendar month in `tz` that contains `now`."""
    today = _local_date(now, tz)
    first = today.replace(day=1)
    following = (
        date(first.year + 1, 1, 1) if first.month == 12 else first.replace(month=first.month + 1)
    )
    return _local_midnight(first, tz), _local_midnight(following, tz)


def day_window(now: datetime, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """UTC bounds of the calendar day in `tz` that contains `now`."""
    today = _local_date(now, tz)
    return _local_midnight(today, tz), _local_midnight(today + timedelta(days=1), tz)
