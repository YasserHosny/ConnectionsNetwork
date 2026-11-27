"""What the metered routes (llm, speech) share."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Literal
from uuid import UUID

import psycopg
from fastapi import Request
from pydantic import BaseModel

from assistant_gateway import ledger
from assistant_gateway.config import GatewayConfig
from assistant_gateway.db import connect


class BudgetOut(BaseModel):
    used_usd: float
    cap_usd: float
    warning: bool


def gateway_config(request: Request) -> GatewayConfig:
    config: GatewayConfig = request.app.state.config
    return config


@contextmanager
def ledger_connection() -> Iterator[psycopg.Connection[Any]]:
    # Opened only once a request has passed validation, and closed again before the provider is
    # called, so nothing is held (no connection, no transaction) while the provider works.
    conn = connect(autocommit=True)
    try:
        yield conn
    finally:
        conn.close()


def close_entry(entry: UUID, how: Literal["release", "mark_unknown"], code: str) -> None:
    with ledger_connection() as conn:
        getattr(ledger, how)(conn, entry, error_code=code)
