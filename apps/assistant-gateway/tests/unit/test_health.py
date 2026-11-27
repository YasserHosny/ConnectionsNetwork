from __future__ import annotations

from fastapi.testclient import TestClient


def test_healthz_ok(client: TestClient) -> None:
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_unknown_route_uses_envelope(client: TestClient) -> None:
    body = client.get("/nope").json()
    assert set(body) == {"code", "message", "details", "trace_id"}
