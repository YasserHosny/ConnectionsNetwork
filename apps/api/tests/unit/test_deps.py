"""Admin auth dependencies (spec 7.1, 11.3): a bearer token, verified, with MFA completed.

Tokens are HS256, signed with the test secret conftest supplies. The routes below exist only in
this test module; Task 5 adds no HTTP endpoints.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from typing import Annotated, Any
from uuid import uuid4

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from jose import jwt

from connections_api import deps
from connections_api.deps import AdminContext, current_admin
from connections_api.errors import register_exception_handlers

SECRET = "test-secret-value-not-used-anywhere-real"
ISSUER = "http://localhost:54321/auth/v1"
AUDIENCE = "authenticated"


def token(**overrides: object) -> str:
    claims: dict[str, object] = {
        "sub": str(uuid4()),
        "network_id": str(uuid4()),
        "member_role": "admin",
        "person_id": str(uuid4()),
        "role": "authenticated",
        "aal": "aal2",
        "aud": AUDIENCE,
        "iss": ISSUER,
        "exp": int(time.time()) + 3600,
    }
    claims.update(overrides)
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, SECRET, "HS256")


def bearer(value: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {value}"}


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/admin-only")
    def admin_only(ctx: Annotated[AdminContext, Depends(current_admin)]) -> dict[str, Any]:
        return {
            "network_id": str(ctx.network_id),
            "person_id": str(ctx.person_id),
            "claims": ctx.claims,
        }

    return TestClient(app)


def test_missing_token_401(client: TestClient) -> None:
    response = client.get("/admin-only")

    assert response.status_code == 401
    assert response.json()["code"] == "auth.unauthenticated"


def test_invalid_token_401(client: TestClient) -> None:
    response = client.get("/admin-only", headers=bearer("not-a-jwt"))

    assert response.status_code == 401
    assert response.json()["code"] == "auth.unauthenticated"


def test_aal1_token_403_mfa_required(client: TestClient) -> None:
    response = client.get("/admin-only", headers=bearer(token(aal="aal1")))

    assert response.status_code == 403
    assert response.json()["code"] == "mfa_required"


def test_token_without_aal_401(client: TestClient) -> None:
    # `aal` is a required claim: a token that does not state its assurance level is not trusted.
    response = client.get("/admin-only", headers=bearer(token(aal=None)))

    assert response.status_code == 401


def test_member_role_403(client: TestClient) -> None:
    # A member holds no aal2 session; the role check must reject on its own as well, so use aal2.
    response = client.get("/admin-only", headers=bearer(token(member_role="member")))

    assert response.status_code == 403
    assert response.json()["code"] == "auth.forbidden"


def test_member_without_mfa_gets_forbidden_not_mfa_required(client: TestClient) -> None:
    # Members never complete TOTP, so telling them to "complete MFA" would be a dead end.
    response = client.get("/admin-only", headers=bearer(token(member_role="member", aal="aal1")))

    assert response.status_code == 403
    assert response.json()["code"] == "auth.forbidden"


def test_token_without_network_claims_401(client: TestClient) -> None:
    # An account with no active member row: the hook stamps no network claims at all.
    response = client.get(
        "/admin-only", headers=bearer(token(network_id=None, member_role=None, person_id=None))
    )

    assert response.status_code == 401


def test_admin_aal2_ok(client: TestClient) -> None:
    network_id, person_id, sub = str(uuid4()), str(uuid4()), str(uuid4())

    response = client.get(
        "/admin-only",
        headers=bearer(token(network_id=network_id, person_id=person_id, sub=sub)),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["network_id"] == network_id
    assert body["person_id"] == person_id
    # The claims have the shape the RLS accessors read (helpers.make_network's admin_claims).
    assert body["claims"] == {
        "sub": sub,
        "network_id": network_id,
        "member_role": "admin",
        "person_id": person_id,
        "role": "authenticated",
        "aal": "aal2",
    }


def test_admin_tx_wraps_user_tx_with_the_admin_claims(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict[str, str]] = []
    sentinel = object()

    from contextlib import contextmanager

    @contextmanager
    def fake_user_tx(claims: dict[str, str]) -> Iterator[object]:
        seen.append(claims)
        yield sentinel

    monkeypatch.setattr(deps, "user_tx", fake_user_tx)
    ctx = AdminContext(network_id=uuid4(), person_id=uuid4(), claims={"sub": "s", "aal": "aal2"})

    generator = deps.admin_tx(ctx)

    assert next(generator) is sentinel
    assert seen == [ctx.claims]
    generator.close()
