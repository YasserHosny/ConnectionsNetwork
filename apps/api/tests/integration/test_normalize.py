"""The normalize_* SQL functions (supabase/migrations/20261119000001_extensions_and_normalize.sql).

Skipped unless TEST_DATABASE_URL is set. CI always sets it, so there an unreachable or
unprepared database fails these tests (the connection raises) rather than hollowing out the suite.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest

from connections_api import db

pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL is not set"
)


@pytest.fixture(scope="module")
def conn() -> Iterator[psycopg.Connection[Any]]:
    with db.connect(os.environ["TEST_DATABASE_URL"], autocommit=True) as connection:
        yield connection


def _apply(conn: psycopg.Connection[Any], function: str, value: str | None) -> str | None:
    row = conn.execute(f"select {function}(%s)", (value,)).fetchone()  # noqa: S608 - fixed names
    assert row is not None
    return row[0]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # Alef variants and diacritics all fold to one spelling.
        ("أحمد", "احمد"),
        ("احمد", "احمد"),
        ("إحمد", "احمد"),
        ("آحمد", "احمد"),
        ("ٱحمد", "احمد"),
        ("أَحْمَد", "احمد"),
        # Taa marbuta, alef maqsura, hamza on waw / ya.
        ("فاطمة", "فاطمه"),
        ("مصطفى", "مصطفي"),
        ("مؤمن", "مومن"),
        ("عائشة", "عايشه"),
        # Tatweel is removed.
        ("محمـــد", "محمد"),
        # Latin: lowercased, whitespace collapsed and trimmed.
        ("  Marketing  ", "marketing"),
        ("Senior \t Product\n Manager", "senior product manager"),
        ("\u00a0Sara\u00a0Ali\u00a0", "sara ali"),
        # Digits are left alone (no Arabic-Indic folding).
        ("Room ١٢٣ 45", "room ١٢٣ 45"),
        ("   ", ""),
        ("", ""),
    ],
)
def test_normalize_text(conn: psycopg.Connection[Any], raw: str, expected: str) -> None:
    assert _apply(conn, "normalize_text", raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("010 1234 5678", "+201012345678"),
        ("+20 10 1234 5678", "+201012345678"),
        ("00201012345678", "+201012345678"),
        ("01012345678", "+201012345678"),
        ("1012345678", "+201012345678"),
        # Country code without + or 00 (WhatsApp / wa.me form): 20 plus ten digits.
        ("201012345678", "+201012345678"),
        # Arabic-Indic and Extended Arabic-Indic digits.
        ("٠١٠١٢٣٤٥٦٧٨", "+201012345678"),
        ("+٢٠ ١٠ ١٢٣٤ ٥٦٧٨", "+201012345678"),
        ("۰۱۰۱۲۳۴۵۶۷۸", "+201012345678"),
        ("(010) 1234-5678", "+201012345678"),
        ("  +20.10.1234.5678  ", "+201012345678"),
        ("(+20) 10 1234 5678", "+201012345678"),
        ("+44 20 7946 0958", "+442079460958"),
        ("0044 20 7946 0958", "+442079460958"),
        # Fewer than 10 digits and no prefix: nothing to infer, digits only.
        ("12345", "12345"),
        # No digits at all is not a phone number.
        ("call me", None),
        ("000", None),
        ("", None),
    ],
)
def test_normalize_phone(conn: psycopg.Connection[Any], raw: str, expected: str | None) -> None:
    assert _apply(conn, "normalize_phone", raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Sara.Ali@Example.COM", "sara.ali@example.com"),
        ("  sara@example.com  ", "sara@example.com"),
        ("\tSARA@example.com\n", "sara@example.com"),
        ("  ", None),
        ("", None),
    ],
)
def test_normalize_email(conn: psycopg.Connection[Any], raw: str, expected: str | None) -> None:
    assert _apply(conn, "normalize_email", raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://www.LinkedIn.com/in/sara/", "linkedin.com/in/sara"),
        ("linkedin.com/in/sara?trk=x", "linkedin.com/in/sara"),
        ("http://github.com/Sara#readme", "github.com/sara"),
        ("HTTPS://WWW.Example.com/", "example.com"),
        ("  https://x.com/sara///  ", "x.com/sara"),
        ("www.facebook.com/sara.ali/?ref=a#b", "facebook.com/sara.ali"),
        ("example.com", "example.com"),
        # Only a leading www. is dropped.
        ("https://blog.www.example.com/a", "blog.www.example.com/a"),
        ("https://", None),
        ("", None),
    ],
)
def test_normalize_url(conn: psycopg.Connection[Any], raw: str, expected: str | None) -> None:
    assert _apply(conn, "normalize_url", raw) == expected


@pytest.mark.parametrize(
    "function", ["normalize_text", "normalize_phone", "normalize_email", "normalize_url"]
)
def test_null_in_null_out(conn: psycopg.Connection[Any], function: str) -> None:
    assert _apply(conn, function, None) is None


def test_functions_are_immutable(conn: psycopg.Connection[Any]) -> None:
    rows = conn.execute(
        "select proname, provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace"
        " where n.nspname = 'public' and proname like 'normalize\\_%'"
    ).fetchall()
    assert {name: volatility for name, volatility in rows} == {
        "normalize_text": "i",
        "normalize_phone": "i",
        "normalize_email": "i",
        "normalize_url": "i",
    }


def test_usable_in_generated_columns_and_independent_of_session_settings(
    conn: psycopg.Connection[Any],
) -> None:
    """Later tables index these through generated columns: that requires true immutability."""
    with conn.transaction():
        conn.execute(
            "create temp table normalize_probe (v text,"
            " t text generated always as (normalize_text(v)) stored,"
            " p text generated always as (normalize_phone(v)) stored,"
            " e text generated always as (normalize_email(v)) stored,"
            " u text generated always as (normalize_url(v)) stored) on commit drop"
        )
        conn.execute("insert into normalize_probe (v) values (%s)", ("010 1234 5678",))
        before = conn.execute("select t, p, e, u from normalize_probe").fetchone()
        # Output must not move with session settings.
        conn.execute("set local search_path = pg_temp")
        conn.execute("set local lc_messages = 'C'")
        after = conn.execute(
            "select public.normalize_text(v), public.normalize_phone(v),"
            " public.normalize_email(v), public.normalize_url(v)"
            " from normalize_probe"
        ).fetchone()
    assert before == after == ("010 1234 5678", "+201012345678", "010 1234 5678", "010 1234 5678")


def test_extensions_installed(conn: psycopg.Connection[Any]) -> None:
    names = {
        row[0]
        for row in conn.execute(
            "select extname from pg_extension where extname in ('pgcrypto', 'pg_trgm')"
        )
    }
    assert names == {"pgcrypto", "pg_trgm"}
