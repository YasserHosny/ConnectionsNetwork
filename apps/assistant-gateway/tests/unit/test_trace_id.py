"""Every response carries the request's trace id: its X-Trace-Id header and, on an error, the
envelope's trace_id. A caller's own id is kept when it is usable; otherwise one is generated."""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from assistant_gateway.logging import configure_logging
from assistant_gateway.main import create_app


@pytest.fixture
def app() -> FastAPI:
    app = create_app(check_migrations=False)

    @app.get("/boom")
    def boom() -> None:
        raise RuntimeError("prompt text that must not be logged")

    return app


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


def test_a_callers_trace_id_is_echoed(client: TestClient) -> None:
    r = client.get("/nowhere", headers={"X-Trace-Id": "  trace-abc  "})
    assert r.status_code == 404
    assert r.headers["X-Trace-Id"] == "trace-abc"
    assert r.json()["trace_id"] == "trace-abc"


@pytest.mark.parametrize("header", [" ", "\t", "x" * 129])
def test_an_unusable_trace_id_is_replaced_and_the_status_kept(
    client: TestClient, header: str
) -> None:
    r = client.get("/nowhere", headers={"X-Trace-Id": header})
    assert r.status_code == 404
    assert r.json()["code"] == "not_found"
    trace_id = r.json()["trace_id"]
    assert trace_id.strip() and trace_id != header.strip()
    assert len(trace_id) <= 128
    assert r.headers["X-Trace-Id"] == trace_id


def test_a_trace_id_of_128_characters_is_kept(client: TestClient) -> None:
    r = client.get("/nowhere", headers={"X-Trace-Id": "t" * 128})
    assert r.json()["trace_id"] == "t" * 128


def test_an_unhandled_error_answers_with_its_own_requests_trace_id(
    client: TestClient, capfd: pytest.CaptureFixture[str]
) -> None:
    configure_logging("info")  # onto the stream capfd now captures
    capfd.readouterr()
    for trace_id in ("trace-one", "trace-two"):
        r = client.get("/boom", headers={"X-Trace-Id": trace_id})
        assert r.status_code == 500
        assert r.json()["code"] == "internal_error"
        assert r.json()["trace_id"] == trace_id
        assert r.headers["X-Trace-Id"] == trace_id
    lines = [json.loads(line) for line in capfd.readouterr().out.splitlines() if line.strip()]
    unhandled = [line for line in lines if line["message"].startswith("Unhandled request")]
    assert [line["trace_id"] for line in unhandled] == ["trace-one", "trace-two"]
    assert all("prompt text" not in json.dumps(line) for line in lines)


def test_an_unhandled_error_without_a_callers_id_still_gets_a_matching_one(
    client: TestClient,
) -> None:
    first = client.get("/boom")
    second = client.get("/boom")
    assert first.json()["trace_id"] == first.headers["X-Trace-Id"]
    assert second.json()["trace_id"] == second.headers["X-Trace-Id"]
    assert first.json()["trace_id"] != second.json()["trace_id"]
