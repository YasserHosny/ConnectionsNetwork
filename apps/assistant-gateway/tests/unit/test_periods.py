from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from assistant_gateway.periods import day_window, month_window

CAIRO = ZoneInfo("Africa/Cairo")


def test_cairo_month_boundary() -> None:
    # 22:30 UTC on 30 Nov is 00:30 on 1 Dec in Cairo (UTC+2 after DST ended in October).
    start, end = month_window(datetime(2026, 11, 30, 22, 30, tzinfo=UTC), CAIRO)
    assert start == datetime(2026, 11, 30, 22, 0, tzinfo=UTC)  # 2026-12-01 00:00 Cairo
    assert end == datetime(2026, 12, 31, 22, 0, tzinfo=UTC)  # 2027-01-01 00:00 Cairo


def test_month_window_just_before_the_cairo_boundary_is_still_november() -> None:
    start, end = month_window(datetime(2026, 11, 30, 21, 59, 59, tzinfo=UTC), CAIRO)
    # 1 Nov 00:00 Cairo is still UTC+2 (DST ended on 29 Oct).
    assert start == datetime(2026, 10, 31, 22, 0, tzinfo=UTC)
    assert end == datetime(2026, 11, 30, 22, 0, tzinfo=UTC)


def test_month_windows_are_half_open_and_adjacent() -> None:
    _, nov_end = month_window(datetime(2026, 11, 15, tzinfo=UTC), CAIRO)
    dec_start, _ = month_window(nov_end, CAIRO)
    assert dec_start == nov_end


def test_month_window_spans_a_dst_change() -> None:
    # October 2026 in Cairo starts at UTC+3 and ends at UTC+2.
    start, end = month_window(datetime(2026, 10, 15, tzinfo=UTC), CAIRO)
    assert start == datetime(2026, 9, 30, 21, 0, tzinfo=UTC)
    assert end == datetime(2026, 10, 31, 22, 0, tzinfo=UTC)


def test_day_window_in_cairo() -> None:
    start, end = day_window(datetime(2026, 11, 27, 23, 0, tzinfo=UTC), CAIRO)
    # 23:00 UTC on 27 Nov is 01:00 on 28 Nov in Cairo.
    assert start == datetime(2026, 11, 27, 22, 0, tzinfo=UTC)
    assert end == datetime(2026, 11, 28, 22, 0, tzinfo=UTC)


def test_day_window_on_a_spring_forward_day_is_23_hours() -> None:
    # Cairo skips 00:00-01:00 on 24 Apr 2026: the day starts at the transition instant.
    start, end = day_window(datetime(2026, 4, 24, 12, 0, tzinfo=UTC), CAIRO)
    assert start == datetime(2026, 4, 23, 22, 0, tzinfo=UTC)
    assert end - start == timedelta(hours=23)


def test_day_window_on_a_fall_back_day_is_25_hours() -> None:
    start, end = day_window(datetime(2026, 10, 29, 12, 0, tzinfo=UTC), CAIRO)
    assert start == datetime(2026, 10, 28, 21, 0, tzinfo=UTC)
    assert end - start == timedelta(hours=25)


def test_windows_are_utc_aware() -> None:
    for window in (month_window, day_window):
        start, end = window(datetime(2026, 11, 27, tzinfo=UTC), CAIRO)
        assert start.tzinfo is UTC and end.tzinfo is UTC


def test_naive_now_is_rejected() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        month_window(datetime(2026, 11, 27), CAIRO)
    with pytest.raises(ValueError, match="timezone-aware"):
        day_window(datetime(2026, 11, 27), CAIRO)
