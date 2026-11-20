"""Every /api/v1 response says `Cache-Control: no-store` (contact data on shared devices, CDNs).

Nginx sets the same header on /api/ (infra/nginx/nginx.conf); this is the API's own copy, so a
deployment that skips the proxy, or a CDN in front of it, still gets told not to keep anything.
"""

from __future__ import annotations

import pytest
from fastapi import Response
from fastapi.testclient import TestClient

from connections_api.main import create_app


@pytest.mark.parametrize(
    ("method", "path", "status"),
    [
        ("GET", "/api/v1/health", 200),
        ("GET", "/api/v1/people/00000000-0000-0000-0000-000000000000", 401),
        ("GET", "/api/v1/no-such-endpoint", 404),
        ("POST", "/api/v1/contribute/people", 422),
    ],
)
def test_api_responses_are_never_stored(method: str, path: str, status: int) -> None:
    response = TestClient(create_app()).request(method, path, json={})

    assert response.status_code == status
    assert response.headers["Cache-Control"] == "no-store"


def test_an_endpoint_header_is_replaced_not_duplicated() -> None:
    app = create_app()

    @app.get("/api/v1/test-cached")
    def cached() -> Response:
        return Response(headers={"Cache-Control": "public, max-age=60"})

    response = TestClient(app).get("/api/v1/test-cached")

    assert response.headers.get_list("Cache-Control") == ["no-store"]
