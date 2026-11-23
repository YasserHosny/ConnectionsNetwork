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
read and write. Contributor-link requests (no session) run inside ``contributor_tx`` instead,
as the narrow ``contributor_api`` role. ``service_role`` is never used on a request path.

Deployed, DATABASE_URL logs in as ``connections_api`` (20261119000009_api_login_role.sql): a
role with no table privileges that can only switch to ``authenticated`` and ``contributor_api``.
A query run outside these helpers is therefore refused rather than run as the RLS-bypassing owner.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg import IsolationLevel, sql


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
def user_tx(
    claims: Mapping[str, str],
    dsn: str | None = None,
    *,
    isolation: IsolationLevel | None = None,
) -> Iterator[psycopg.Connection[Any]]:
    """A transaction that runs as the request's user, under row-level security.

    ``set local role`` switches to ``authenticated``, or to ``anon`` when there are no claims,
    and ``request.jwt.claims`` carries the claims the RLS accessors read (current_network_id()
    and friends). Both are transaction-local, so they end with the transaction and never leak to
    the next user of a pooled backend. Commits when the block exits normally, rolls back when it
    raises.

    dsn defaults to the configured DATABASE_URL (tests pass TEST_DATABASE_URL). isolation sets
    the transaction's isolation level (default: the server's, READ COMMITTED); a multi-statement
    read that must see one coherent state passes REPEATABLE_READ.
    """
    with _role_tx("authenticated" if claims else "anon", claims, dsn, isolation) as conn:
        yield conn


@contextmanager
def contributor_tx(dsn: str | None = None) -> Iterator[psycopg.Connection[Any]]:
    """A transaction for a contributor-link request (no session, no claims).

    Runs as ``contributor_api``, the one role that may execute the contributor-link functions
    (20261119000008) and that holds nothing else. Not ``anon``: PostgREST serves ``anon`` to
    anyone holding the public anon key, and a direct RPC call would skip the API's rate limits.
    """
    with _role_tx("contributor_api", {}, dsn, None) as conn:
        yield conn


@contextmanager
def _role_tx(
    role: str, claims: Mapping[str, str], dsn: str | None, isolation: IsolationLevel | None
) -> Iterator[psycopg.Connection[Any]]:
    with connect(dsn) as conn:
        if isolation is not None:
            # Must be set before the transaction's first statement takes its snapshot.
            conn.isolation_level = isolation
        with conn.transaction():
            conn.execute(sql.SQL("set local role {}").format(sql.Identifier(role)))
            conn.execute(
                "select set_config('request.jwt.claims', %s, true)", (json.dumps(dict(claims)),)
            )
            yield conn
