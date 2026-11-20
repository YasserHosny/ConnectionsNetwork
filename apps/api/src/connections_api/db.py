"""The one place a psycopg connection is opened.

DATABASE_URL on hosted is Supabase's transaction-mode pooler (port 6543), which hands the
same backend session to many client connections. psycopg 3 auto-prepares a query after
``prepare_threshold`` (default 5) executions on one connection, naming it ``_pg3_0``,
``_pg3_1``, ... per connection; two client connections sharing a backend then collide with
``DuplicatePreparedStatement: prepared statement "_pg3_0" already exists``. Every connection
therefore disables server-side prepared statements. A guard test fails if ``psycopg.connect``
is called anywhere else in this package.

Request paths run inside ``user_tx``: a transaction switched to the ``authenticated`` (or
``anon``) role with the verified JWT claims set, so Postgres RLS decides what the request may
read and write. ``service_role`` is never used on a request path.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from typing import Any

import psycopg


def connect(dsn: str | None = None, **kwargs: object) -> psycopg.Connection[Any]:
    """Open a connection with prepared statements disabled; other kwargs pass through.

    dsn defaults to the configured DATABASE_URL. Any caller-supplied
    prepare_threshold is overridden: there is no safe value behind the pooler.
    """
    if dsn is None:
        from connections_api.config import get_settings

        dsn = get_settings().database_url.get_secret_value()
    kwargs["prepare_threshold"] = None
    return psycopg.connect(dsn, **kwargs)  # type: ignore[arg-type]


@contextmanager
def user_tx(claims: Mapping[str, str], dsn: str | None = None) -> Iterator[psycopg.Connection[Any]]:
    """A transaction that runs as the request's user, under row-level security.

    ``set local role`` switches to ``authenticated``, or to ``anon`` when there are no claims
    (a contributor-link request has no session), and ``request.jwt.claims`` carries the claims
    the RLS accessors read (current_network_id() and friends). Both are transaction-local, so
    they end with the transaction and never leak to the next user of a pooled backend.
    Commits when the block exits normally, rolls back when it raises.

    dsn defaults to the configured DATABASE_URL (tests pass TEST_DATABASE_URL).
    """
    with connect(dsn) as conn, conn.transaction():
        conn.execute("set local role authenticated" if claims else "set local role anon")
        conn.execute(
            "select set_config('request.jwt.claims', %s, true)", (json.dumps(dict(claims)),)
        )
        yield conn
