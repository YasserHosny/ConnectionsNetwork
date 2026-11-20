"""The `Idempotency-Key` request header (spec 11.1, the blueprint convention; ruling R18).

A client sends one key per submission and the same key on every retry of it. The create
endpoints store the key with the person they create (table `idempotency_key`), and a retry with
the same key answers with that person instead of creating a second one. Keys are kept 7 days.

A key is a UUID or any 1-128 characters of [A-Za-z0-9_-]; anything else is a 422 before the
request reaches the database (which checks the same rule again).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Header

IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"
IDEMPOTENCY_KEY_PATTERN = r"^[A-Za-z0-9_-]{1,128}$"
# How long a stored key answers a replay; older keys are purged when a new one is stored.
IDEMPOTENCY_KEY_TTL = "7 days"

IdempotencyKey = Annotated[
    str | None, Header(alias=IDEMPOTENCY_KEY_HEADER, pattern=IDEMPOTENCY_KEY_PATTERN)
]
