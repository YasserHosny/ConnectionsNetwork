from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from assistant_gateway.main import create_app

Q = {"use_case": "person_add", "end_user_id": "user-1"}


@pytest.fixture
def no_db_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """Requests that fail before the database must not need one."""

    def _no_connection(*_a: object, **_k: object) -> None:
        raise AssertionError("a refused request must not open a database connection")

    monkeypatch.setattr("assistant_gateway.routes.common.connect", _no_connection)
    with TestClient(create_app(check_migrations=False)) as c:
        yield c


def test_missing_header_is_401(no_db_client: TestClient) -> None:
    r = no_db_client.get("/v1/status", params=Q)
    assert r.status_code == 401
    assert r.json()["code"] == "auth.unauthenticated"
    assert set(r.json()) == {"code", "message", "details", "trace_id"}


def test_unknown_key_is_401(no_db_client: TestClient) -> None:
    r = no_db_client.get("/v1/status", params=Q, headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401
    assert r.json()["code"] == "auth.unauthenticated"


@pytest.mark.parametrize("shape", ["Basic {k}", "{k}", "Bearer", "Bearer "])
def test_malformed_authorization_is_401(
    no_db_client: TestClient, auth: dict[str, str], shape: str
) -> None:
    key = auth["Authorization"].removeprefix("Bearer ")
    r = no_db_client.get("/v1/status", params=Q, headers={"Authorization": shape.format(k=key)})
    assert r.status_code == 401
    assert r.json()["code"] == "auth.unauthenticated"


def test_error_never_echoes_the_key(no_db_client: TestClient) -> None:
    r = no_db_client.get(
        "/v1/status", params=Q, headers={"Authorization": "Bearer sentinel-secret-key"}
    )
    assert "sentinel-secret-key" not in r.text


def test_unknown_use_case_is_422(no_db_client: TestClient, auth: dict[str, str]) -> None:
    q = {**Q, "use_case": "nope"}
    r = no_db_client.get("/v1/status", params=q, headers=auth)
    assert r.status_code == 422
    assert r.json()["code"] == "unknown_use_case"


def test_use_case_of_another_app_is_unknown(
    no_db_client: TestClient, other_auth: dict[str, str]
) -> None:
    # other-app defines no `eval`; each app sees only its own use cases.
    r = no_db_client.get("/v1/status", params={**Q, "use_case": "eval"}, headers=other_auth)
    assert r.status_code == 422
    assert r.json()["code"] == "unknown_use_case"


@pytest.mark.parametrize("end_user_id", ["", "x" * 129])
def test_bad_end_user_id_is_422(
    no_db_client: TestClient, auth: dict[str, str], end_user_id: str
) -> None:
    r = no_db_client.get("/v1/status", params={**Q, "end_user_id": end_user_id}, headers=auth)
    assert r.status_code == 422
    assert r.json()["code"] == "validation.invalid_request"


def test_missing_end_user_id_is_422(no_db_client: TestClient, auth: dict[str, str]) -> None:
    r = no_db_client.get("/v1/status", params={"use_case": "person_add"}, headers=auth)
    assert r.status_code == 422
