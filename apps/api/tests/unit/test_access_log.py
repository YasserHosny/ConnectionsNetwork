from __future__ import annotations

import logging

import pytest

from connections_api.shared.logging import configure_logging

# uvicorn's access logger formats `<client> - "<method> <path-with-query> HTTP/<v>" <status>`.
ACCESS_FORMAT = '%s - "%s %s HTTP/%s" %d'
CLIENT = "203.0.113.7:51234"


def _access_line(capsys: pytest.CaptureFixture[str], path: str) -> str:
    # configure_logging binds its handler to the current sys.stdout, so it must run inside the
    # test body, after capsys has swapped it in.
    configure_logging("info")
    logging.getLogger("uvicorn.access").info(ACCESS_FORMAT, CLIENT, "GET", path, "1.1", 200)
    out = capsys.readouterr().out
    assert out, "nothing was logged to stdout"
    return out


def test_uvicorn_access_log_drops_the_query_string(capsys: pytest.CaptureFixture[str]) -> None:
    out = _access_line(capsys, "/api/v1/tags?kind=skill&q=secret-search")

    assert "GET /api/v1/tags 200" in out
    assert "secret-search" not in out
    assert "kind=skill" not in out
    assert "?" not in out


def test_uvicorn_access_log_keeps_a_path_without_a_query(
    capsys: pytest.CaptureFixture[str],
) -> None:
    out = _access_line(capsys, "/api/v1/health")

    assert "GET /api/v1/health 200" in out


def test_uvicorn_access_log_logs_no_client_address(capsys: pytest.CaptureFixture[str]) -> None:
    out = _access_line(capsys, "/api/v1/health")

    assert "203.0.113.7" not in out


def test_access_log_filter_is_not_stacked_by_repeated_configuration(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("info")
    out = _access_line(capsys, "/api/v1/tags?q=secret-search")

    assert out.count("GET /api/v1/tags 200") == 1
    assert len(logging.getLogger("uvicorn.access").filters) == 1
