"""Export of every row of the admin's network, as one JSON document or a zip of CSV files.

Runs on the admin's transaction, so row-level security scopes every table to the network. Each
table's columns are read from the catalog, so a column added later is exported without a code
change; a table added later must be listed in `_TABLES` (a test checks the list against the
schema). Two columns never leave the database:

  * `contributor_link.token_hash`: the link's secret (spec 11.4); it is the credential itself.
  * `member.user_id`: the identity of the sign-in account, which belongs to Supabase Auth. The
    export reads nothing from the `auth` schema.

JSON is the lossless format. CSV neutralises leading formula characters (`_csv_cell`), so a
cell can differ from the stored value by a leading quote.

Nothing here logs: the rows are contact details and names.
"""

from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

import psycopg
from psycopg import sql
from psycopg.rows import tuple_row

type Conn = psycopg.Connection[Any]

# table -> the columns that give a stable row order (the primary key).
_TABLES: dict[str, tuple[str, ...]] = {
    "network": ("id",),
    "member": ("id",),
    "person": ("id",),
    "tag": ("id",),
    "person_skill": ("person_id", "tag_id"),
    "person_industry": ("person_id", "tag_id"),
    "social_link": ("id",),
    "contact_value": ("id",),
    "connection": ("id",),
    "contributor_link": ("id",),
    "duplicate_dismissal": ("person_a", "person_b"),
}

_NEVER_EXPORTED: frozenset[tuple[str, str]] = frozenset(
    {("contributor_link", "token_hash"), ("member", "user_id")}
)

# Excel and Sheets run a cell starting with one of these as a formula (or a DDE command).
# Contributors submit free text through public links and the admin opens this file in a
# spreadsheet, so such a cell is prefixed with a single quote. A phone number may start with
# '+'; a cell of only digits, spaces and ().- cannot carry a formula, so those are left byte
# for byte.
_FORMULA_STARTS = ("=", "+", "-", "@", "\t", "\r")
_PHONE_LIKE = re.compile(r"\+?[0-9][0-9 ().\-]*")

# CSV has no list type: a multi-valued column (person.available_for) is joined with this.
CSV_LIST_SEPARATOR = ";"


class ExportFormat(StrEnum):
    JSON = "json"
    CSV = "csv"


class ExportTable:
    """One table's exported columns and rows."""

    def __init__(self, columns: list[str], rows: list[tuple[Any, ...]]) -> None:
        self.columns = columns
        self.rows = rows


def _columns(conn: Conn, table: str) -> list[str]:
    found = conn.execute(
        "select column_name from information_schema.columns"
        " where table_schema = 'public' and table_name = %s order by ordinal_position",
        (table,),
    ).fetchall()
    return [name for (name,) in found if (table, name) not in _NEVER_EXPORTED]


def read_tables(conn: Conn) -> dict[str, ExportTable]:
    """Every table of the network: its columns (header) and its rows in primary-key order."""
    tables: dict[str, ExportTable] = {}
    for table, order in _TABLES.items():
        columns = _columns(conn, table)
        query = sql.SQL("select {cols} from {table} order by {order}").format(
            cols=sql.SQL(", ").join(sql.Identifier(c) for c in columns),
            table=sql.Identifier("public", table),
            order=sql.SQL(", ").join(sql.Identifier(c) for c in order),
        )
        with conn.cursor(row_factory=tuple_row) as cur:
            tables[table] = ExportTable(columns, cur.execute(query).fetchall())
    return tables


def _json_default(value: object) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    raise TypeError(f"cannot export a {type(value).__name__}")


def to_json(network_id: UUID, tables: dict[str, ExportTable], exported_at: datetime) -> bytes:
    document = {
        "exported_at": exported_at.isoformat(),
        "network_id": str(network_id),
        "tables": {
            name: [dict(zip(table.columns, row, strict=True)) for row in table.rows]
            for name, table in tables.items()
        },
    }
    return json.dumps(document, default=_json_default, ensure_ascii=False).encode("utf-8")


def _csv_cell(value: object) -> str:
    """One CSV cell. Text a spreadsheet would run as a formula is neutralised (see below)."""
    if value is None:
        return ""
    if isinstance(value, list):
        text = CSV_LIST_SEPARATOR.join(str(item) for item in value)
    elif isinstance(value, datetime):
        text = value.isoformat()
    else:
        text = str(value)
    if text.startswith(_FORMULA_STARTS) and not _PHONE_LIKE.fullmatch(text):
        return "'" + text
    return text


def to_csv_zip(tables: dict[str, ExportTable]) -> bytes:
    """A zip with one `<table>.csv` per table; the header row is there even for an empty table."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, table in tables.items():
            text = io.StringIO(newline="")
            writer = csv.writer(text)
            writer.writerow(table.columns)
            for row in table.rows:
                writer.writerow(_csv_cell(v) for v in row)
            archive.writestr(f"{name}.csv", text.getvalue().encode("utf-8"))
    return buffer.getvalue()


def export_network(
    conn: Conn, network_id: UUID, fmt: ExportFormat, now: datetime | None = None
) -> tuple[bytes, str]:
    """The export in `fmt` and its filename (`connections-export-<UTC date>.json|zip`)."""
    exported_at = now or datetime.now(UTC)
    tables = read_tables(conn)
    stamp = exported_at.astimezone(UTC).date().isoformat()
    if fmt is ExportFormat.JSON:
        return to_json(network_id, tables, exported_at), f"connections-export-{stamp}.json"
    return to_csv_zip(tables), f"connections-export-{stamp}.zip"
