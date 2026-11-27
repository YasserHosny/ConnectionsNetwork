"""Request bodies are capped before anything parses them, authentication included.

Starlette spools a multipart upload to disk while FastAPI resolves the form, which happens before
the app-key dependency and before the route's own 10 MB check. The cap therefore sits in an ASGI
middleware that answers 413 from the declared Content-Length, or stops reading a body sent
without one as soon as it passes the cap.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.formparsers import MultiPartParser
from starlette.types import Receive, Send

from assistant_gateway.body_limit import BodySizeLimit, llm_body_limit
from assistant_gateway.config import load_config
from assistant_gateway.main import create_app

MiB = 1024 * 1024
TRANSCRIBE = "/v1/speech/transcribe"


class _Recorder:
    """An inner ASGI app that reads the whole body and answers 200 with its length."""

    def __init__(self) -> None:
        self.called = False
        self.received = 0
        self.disconnected = False

    async def __call__(self, scope: dict[str, Any], receive: Receive, send: Send) -> None:
        self.called = True
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                self.disconnected = True
                break
            self.received += len(message.get("body", b""))
            if not message.get("more_body", False):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": str(self.received).encode()})


def _limited(inner: _Recorder, limit: int = 1000) -> BodySizeLimit:
    return BodySizeLimit(inner, limits={"/capped": limit}, default=10)


def test_a_declared_length_over_the_cap_is_refused_without_calling_the_app() -> None:
    inner = _Recorder()
    r = TestClient(_limited(inner)).post("/capped", content=b"x" * 1001)
    assert r.status_code == 413
    assert r.json()["code"] == "request_too_large"
    assert r.json()["trace_id"]
    assert inner.called is False


def test_a_body_at_the_cap_passes_through_whole() -> None:
    inner = _Recorder()
    r = TestClient(_limited(inner)).post("/capped", content=b"x" * 1000)
    assert r.status_code == 200
    assert r.text == "1000"


def test_paths_without_their_own_cap_get_the_default() -> None:
    inner = _Recorder()
    client = TestClient(_limited(inner))
    assert client.post("/other", content=b"x" * 10).status_code == 200
    assert client.post("/other", content=b"x" * 11).status_code == 413


def test_a_chunked_body_over_the_cap_is_refused() -> None:
    # A generator body goes out without Content-Length (Transfer-Encoding: chunked).
    inner = _Recorder()

    def chunks() -> Iterator[bytes]:
        for _ in range(5):
            yield b"x" * 300

    r = TestClient(_limited(inner)).post("/capped", content=chunks())
    assert r.status_code == 413
    assert r.json()["code"] == "request_too_large"


def test_reading_stops_at_the_chunk_that_passes_the_cap() -> None:
    """Driven at the ASGI level, so each chunk is its own receive: nothing past the chunk that
    crossed the cap is pulled from the server, and the app sees a disconnect, not the rest."""
    inner = _Recorder()
    pulled: list[int] = []
    sent: list[dict[str, Any]] = []
    chunk = b"x" * 300

    async def receive() -> dict[str, Any]:
        pulled.append(len(chunk))
        return {"type": "http.request", "body": chunk, "more_body": True}  # never ends

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/capped", "headers": []}
    asyncio.run(_limited(inner)(scope, receive, send))
    assert sum(pulled) == 1200  # the fourth chunk crossed 1000; no fifth was read
    assert inner.disconnected is True
    assert [m["status"] for m in sent if m["type"] == "http.response.start"] == [413]
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    assert json.loads(body)["code"] == "request_too_large"


@pytest.fixture
def no_spool(monkeypatch: pytest.MonkeyPatch) -> None:
    def _refuse(*_a: object, **_k: object) -> None:
        raise AssertionError("an oversized upload must be refused before multipart parsing")

    monkeypatch.setattr(MultiPartParser, "parse", _refuse)


@pytest.fixture
def app_client() -> TestClient:
    return TestClient(create_app(check_migrations=False))


@pytest.mark.usefixtures("no_spool")
def test_an_unauthenticated_oversized_upload_is_refused_before_it_is_parsed(
    app_client: TestClient,
) -> None:
    # No Authorization header: before the cap this was spooled to disk, then answered 401.
    r = app_client.post(
        TRANSCRIBE,
        data={"use_case": "dictate", "end_user_id": "u"},
        files={"file": ("a.webm", b"\0" * (12 * MiB), "audio/webm")},
    )
    assert r.status_code == 413
    assert r.json()["code"] == "request_too_large"
    assert r.headers["X-Trace-Id"] == r.json()["trace_id"]


def test_a_chunked_oversized_upload_is_refused(app_client: TestClient) -> None:
    # No Content-Length, so parsing may start; the cap cuts the body off as it is read.
    def chunks() -> Iterator[bytes]:
        for _ in range(12):
            yield b"\0" * MiB

    r = app_client.post(
        TRANSCRIBE,
        content=chunks(),
        headers={"Content-Type": "multipart/form-data; boundary=x"},
    )
    assert r.status_code == 413
    assert r.json()["code"] == "request_too_large"


def test_an_upload_at_the_audio_cap_still_reaches_the_route(app_client: TestClient) -> None:
    # 10 MB of audio plus the form fields: under the request cap, so the route runs (and,
    # with no app key, answers 401).
    r = app_client.post(
        TRANSCRIBE,
        data={"use_case": "dictate", "end_user_id": "u"},
        files={"file": ("a.webm", b"\0" * (10 * MiB), "audio/webm")},
    )
    assert r.status_code == 401


def test_an_oversized_llm_body_is_refused(app_client: TestClient) -> None:
    r = app_client.post(
        "/v1/llm/messages",
        content=b'{"system": "' + b"x" * (2 * MiB) + b'"}',
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 413
    assert r.json()["code"] == "request_too_large"


def test_the_largest_allowed_llm_text_fits_however_it_is_encoded(app_client: TestClient) -> None:
    # max_input_chars of astral characters, each escaped by json.dumps as two \\uXXXX (12 bytes):
    # the most bytes a request that fits the character limit can take. It must reach the route.
    config = app_client.app.state.config  # type: ignore[attr-defined]
    chars = max(c.max_input_chars for a in config.apps.values() for c in a.use_cases.values())
    body = {
        "use_case": "person_add",
        "end_user_id": "u",
        "system": "\U0001f600" * chars,
        "messages": [{"role": "user", "content": "x"}],
    }
    encoded = json.dumps(body).encode()
    assert len(encoded) > 12 * chars
    r = app_client.post(
        "/v1/llm/messages", content=encoded, headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 401


def test_the_llm_cap_follows_the_largest_max_input_chars(tmp_path: Path) -> None:
    from assistant_gateway.settings import get_settings

    config = load_config(get_settings().ag_config_path, os.environ)
    assert llm_body_limit(config) == 1 * MiB  # the floor: 20 000 chars need far less
    source = get_settings().ag_config_path.read_text()
    big = tmp_path / "big.yaml"
    big.write_text(source.replace("max_input_chars: 50", "max_input_chars: 200000"))
    assert llm_body_limit(load_config(big, os.environ)) == 12 * 200_000 + 256 * 1024
