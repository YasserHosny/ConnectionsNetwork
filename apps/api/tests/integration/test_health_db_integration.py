"""GET /api/v1/health/db against a real database (`select 1` through db.connect).

Skipped unless TEST_DATABASE_URL is set (CI always sets it).
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from connections_api.main import app

pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL is not set"
)


def test_health_db_reaches_the_database() -> None:
    response = TestClient(app).get("/api/v1/health/db")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
