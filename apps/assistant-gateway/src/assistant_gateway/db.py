"""The one place a psycopg connection is opened.

AG_DATABASE_URL on hosted is Supabase's transaction-mode pooler, which hands the same backend
session to many client connections. psycopg 3 auto-prepares a query after ``prepare_threshold``
executions on one connection; two client connections sharing a backend then collide on the
prepared statement's name. Every connection therefore disables server-side prepared statements.
"""

from __future__ import annotations

from typing import Any

import psycopg

from assistant_gateway.settings import get_settings


def connect(dsn: str | None = None, **kwargs: object) -> psycopg.Connection[Any]:
    """Open a connection with prepared statements disabled; other kwargs pass through.

    dsn defaults to the configured AG_DATABASE_URL. Any caller-supplied prepare_threshold is
    overridden: there is no safe value behind the pooler.
    """
    if dsn is None:
        dsn = get_settings().ag_database_url.get_secret_value()
    kwargs["prepare_threshold"] = None
    return psycopg.connect(dsn, **kwargs)  # type: ignore[arg-type]
