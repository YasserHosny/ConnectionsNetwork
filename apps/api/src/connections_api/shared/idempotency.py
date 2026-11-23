"""The `Idempotency-Key` request header (spec 11.1, the blueprint convention; ruling R18).

A client sends one key per submission and the same key on every retry of it. The create
endpoints store the key with the person they create and a hash of the request (table
`idempotency_key`). A retry with the same key and the same request answers with that person
instead of creating a second one; the same key with a different request is a 422
`idempotency_key_reused`, never a silent replay that drops the changes. Keys are kept 7 days.

A key is a UUID or any 1-128 characters of [A-Za-z0-9_-]; anything else is a 422 before the
request reaches the database (which checks the same rule again).
"""

from __future__ import annotations

import hashlib
import json
from typing import Annotated

from fastapi import Header
from pydantic import BaseModel

from connections_api.errors import ValidationFailed

IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"
IDEMPOTENCY_KEY_PATTERN = r"^[A-Za-z0-9_-]{1,128}$"
# How long a stored key answers a replay; older keys are purged when a new one is stored.
IDEMPOTENCY_KEY_TTL = "7 days"

IdempotencyKey = Annotated[
    str | None, Header(alias=IDEMPOTENCY_KEY_HEADER, pattern=IDEMPOTENCY_KEY_PATTERN)
]

# Raised by contribute_person when a link's key is replayed with another payload.
IDEMPOTENCY_KEY_REUSED_SQLSTATE = "CN001"


class IdempotencyKeyReusedError(ValidationFailed):
    """The key already created a person from a different request; nothing is written."""

    code = "idempotency_key_reused"
    safe_message = "This Idempotency-Key was already used with a different request."


def request_hash(request: BaseModel) -> str:
    """sha256 (lowercase hex) of the request as canonical JSON: sorted keys, no whitespace."""
    canonical = json.dumps(
        request.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode()).hexdigest()
