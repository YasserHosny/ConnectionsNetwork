"""CSV cells: leading formula characters are neutralised, phone numbers are left alone."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from connections_api.modules.export.service import _csv_cell


@pytest.mark.parametrize(
    "value", ["=1+1", "+1+1", "-1+1", "@SUM(A1)", "\tx", "\rx", "=", "+", "-5"]
)
def test_leading_formula_characters_are_quoted(value: str) -> None:
    assert _csv_cell(value) == "'" + value


@pytest.mark.parametrize(
    "value",
    ["+201012345678", "+20 10 1234 5678", "01012345678", "+20 (10) 1234-5678", "0100.123.4567"],
)
def test_phone_like_cells_are_unchanged(value: str) -> None:
    assert _csv_cell(value) == value


@pytest.mark.parametrize("value", ["Ahmed", "", "a=b", "1+1", "2026-11-20"])
def test_other_text_is_unchanged(value: str) -> None:
    assert _csv_cell(value) == value


def test_none_lists_and_datetimes() -> None:
    assert _csv_cell(None) == ""
    assert _csv_cell(["a", "b"]) == "a;b"
    assert _csv_cell(["=x", "b"]) == "'=x;b"
    assert _csv_cell(datetime(2026, 11, 20, 1, 2, 3, tzinfo=UTC)) == "2026-11-20T01:02:03+00:00"
