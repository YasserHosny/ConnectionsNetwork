from __future__ import annotations

from fastapi.testclient import TestClient

from connections_api.main import app


def test_health_ok() -> None:
    response = TestClient(app).get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["X-Trace-Id"]
