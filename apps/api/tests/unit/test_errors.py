from __future__ import annotations

import logging

import psycopg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from connections_api.errors import (
    AuthenticationError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ValidationFailed,
    register_exception_handlers,
)
from connections_api.shared.logging import TraceIdMiddleware


class Payload(BaseModel):
    name: str


def _client() -> TestClient:
    app = FastAPI()
    app.add_middleware(TraceIdMiddleware)
    register_exception_handlers(app)

    @app.get("/raise/{kind}")
    def raise_error(kind: str) -> None:
        errors = {
            "not_found": NotFoundError,
            "unauthenticated": AuthenticationError,
            "forbidden": ForbiddenError,
            "conflict": ConflictError,
            "invalid": ValidationFailed,
        }
        if kind == "boom":
            raise RuntimeError("secret internals")
        if kind == "db":
            # Database messages quote the offending values (DETAIL: Key (name)=(...)).
            raise psycopg.errors.UniqueViolation("duplicate key: Sara Mahmoud, sara at example")
        raise errors[kind](details={"id": "42"})

    @app.post("/payload")
    def post_payload(payload: Payload) -> None:
        return None

    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    ("kind", "status", "code"),
    [
        ("not_found", 404, "not_found"),
        ("unauthenticated", 401, "auth.unauthenticated"),
        ("forbidden", 403, "auth.forbidden"),
        ("conflict", 409, "conflict"),
        ("invalid", 422, "validation.invalid_value"),
    ],
)
def test_app_errors_use_the_envelope(kind: str, status: int, code: str) -> None:
    response = _client().get(f"/raise/{kind}", headers={"X-Trace-Id": "trace-1"})

    assert response.status_code == status
    body = response.json()
    assert set(body) == {"code", "message", "details", "trace_id"}
    assert body["code"] == code
    assert body["details"] == {"id": "42"}
    assert body["trace_id"] == "trace-1"


def test_unknown_route_is_a_404_envelope() -> None:
    response = _client().get("/nope")

    assert response.status_code == 404
    assert response.json()["code"] == "not_found"


def test_request_validation_is_a_422_envelope() -> None:
    response = _client().post("/payload", json={})

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation.invalid_request"
    assert body["details"][0]["field"] == "name"


def test_unhandled_exception_does_not_leak_internals() -> None:
    response = _client().get("/raise/boom")

    assert response.status_code == 500
    assert response.json()["code"] == "internal_error"
    assert "secret internals" not in response.text


def test_unhandled_database_error_logs_only_its_class(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.ERROR, logger="connections_api.errors"):
        response = _client().get("/raise/db")

    assert response.status_code == 500
    assert "Sara" not in response.text
    records = [r for r in caplog.records if r.name == "connections_api.errors"]
    assert len(records) == 1
    record = records[0]
    assert "UniqueViolation" in record.getMessage()
    assert "Sara" not in record.getMessage()
    assert record.exc_info is None
    assert record.__dict__["path"] == "/raise/db"


def test_unhandled_exception_keeps_its_traceback(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.ERROR, logger="connections_api.errors"):
        _client().get("/raise/boom")

    records = [r for r in caplog.records if r.name == "connections_api.errors"]
    assert len(records) == 1
    assert records[0].exc_info is not None
