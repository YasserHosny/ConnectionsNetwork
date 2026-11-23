"""FastAPI dependencies: who is calling, and the database transaction they run in.

Admin endpoints need a verified Supabase access token whose member role is `admin` and whose
`aal` claim is `aal2` (TOTP MFA completed; spec 7.1). `service_role` is never involved: every
admin query runs through `admin_tx`, i.e. `user_tx`, so row-level security applies.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Annotated, Any
from uuid import UUID

import psycopg
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from psycopg import IsolationLevel

from connections_api.config import Settings, get_settings
from connections_api.db import user_tx
from connections_api.errors import AuthenticationError, ForbiddenError, MfaRequiredError
from connections_api.modules.auth.jwt import verify_supabase_jwt

_bearer = HTTPBearer(auto_error=False)

REQUIRED_AAL = "aal2"


@dataclass(frozen=True)
class AdminContext:
    network_id: UUID
    person_id: UUID
    # The verified token's claims, shaped as the RLS accessors read them (current_network_id()
    # and friends). Handed to user_tx unchanged.
    claims: dict[str, str]


def current_admin(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> AdminContext:
    """The verified admin behind the request, or 401 / 403.

    401: no bearer token, or one that fails verification (including a token with no network
    claims). 403 `auth.forbidden`: the account is not an admin. 403 `mfa_required`: an admin
    session that has not completed TOTP. The role is checked first so a plain member is not told
    to complete an MFA step they can never have.
    """
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise AuthenticationError(details={"reason": "missing_bearer_token"})

    token = verify_supabase_jwt(credentials.credentials, settings)

    if token.member_role != "admin":
        raise ForbiddenError()
    if token.aal != REQUIRED_AAL:
        raise MfaRequiredError()

    return AdminContext(
        network_id=token.network_id,
        person_id=token.person_id,
        claims={
            "sub": str(token.sub),
            "network_id": str(token.network_id),
            "member_role": token.member_role,
            "person_id": str(token.person_id),
            # Not taken from the token: user_tx switches to this Postgres role itself, and the
            # `role` claim is Supabase's, never an application role.
            "role": "authenticated",
            "aal": token.aal,
        },
    )


def admin_tx(
    ctx: Annotated[AdminContext, Depends(current_admin)],
) -> Iterator[psycopg.Connection[Any]]:
    """A transaction as the admin, under RLS. Commits on success, rolls back on an error."""
    with user_tx(ctx.claims) as conn:
        yield conn


def admin_snapshot_tx(
    ctx: Annotated[AdminContext, Depends(current_admin)],
) -> Iterator[psycopg.Connection[Any]]:
    """Like admin_tx, but every statement reads from one REPEATABLE READ snapshot.

    For multi-table reads that must be internally consistent (the export): under the default
    READ COMMITTED each statement sees whatever committed before it, so a submission landing
    mid-read could leave a contact value without its person.
    """
    with user_tx(ctx.claims, isolation=IsolationLevel.REPEATABLE_READ) as conn:
        yield conn
