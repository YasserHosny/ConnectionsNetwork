"""Requests the speech route refuses before it reserves anything: no database is needed.

`connect` is replaced by a function that fails the test, so a refusal that opened a connection
(or went on to call the provider) would be caught.
"""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest
from audio_samples import webm_opus_no_duration
from fakes import FakeSpeech
from fastapi.testclient import TestClient

from assistant_gateway.main import create_app
from assistant_gateway.providers.speech import SpeechResult

AUDIO = webm_opus_no_duration(3.0)


@pytest.fixture
def fake() -> FakeSpeech:
    return FakeSpeech(SpeechResult("x"))


@pytest.fixture
def no_db_client(fake: FakeSpeech, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    def _no_connection(*_a: object, **_k: object) -> None:
        raise AssertionError("a refused request must not open a database connection")

    monkeypatch.setattr("assistant_gateway.routes.common.connect", _no_connection)
    with TestClient(create_app(speech={"openai": fake}, check_migrations=False)) as c:
        yield c


def post(
    client: TestClient, headers: dict[str, str], audio: bytes = AUDIO, **fields: str
) -> httpx.Response:
    data = {"use_case": "dictate", "end_user_id": "u", **fields}
    return client.post(
        "/v1/speech/transcribe",
        data=data,
        files={"file": ("a.webm", audio, "audio/webm")},
        headers=headers,
    )


@pytest.mark.parametrize(
    ("fields", "audio", "status", "code"),
    [
        ({"use_case": "person_add"}, AUDIO, 409, "speech_mode_browser"),
        ({"use_case": "nope"}, AUDIO, 422, "unknown_use_case"),
        ({"use_case": "dictate_eleven"}, AUDIO, 502, "provider_unavailable"),
        ({"use_case": "dictate_trial"}, AUDIO, 422, "provider_required"),
        ({"use_case": "dictate_trial", "provider": "x"}, AUDIO, 422, "provider_not_allowed"),
        ({}, b"\0" * (10 * 1024 * 1024 + 1), 413, "audio_too_large"),
        ({}, b"garbage", 415, "unsupported_audio"),
        ({}, webm_opus_no_duration(61.0), 413, "audio_too_long"),
        ({"end_user_id": ""}, AUDIO, 422, "validation.invalid_request"),
        ({"end_user_id": "u" * 129}, AUDIO, 422, "validation.invalid_request"),
        ({"end_user_id": "u\x00x"}, AUDIO, 422, "validation.invalid_request"),
    ],
    ids=[
        "browser_mode",
        "unknown_use_case",
        "no_adapter",
        "provider_required",
        "provider_not_allowed",
        "too_large",
        "unsupported",
        "too_long",
        "empty_user",
        "long_user",
        "nul_user",
    ],
)
def test_refused_without_touching_the_database_or_provider(
    no_db_client: TestClient,
    auth: dict[str, str],
    fake: FakeSpeech,
    fields: dict[str, str],
    audio: bytes,
    status: int,
    code: str,
) -> None:
    r = post(no_db_client, auth, audio, **fields)
    assert (r.status_code, r.json()["code"]) == (status, code)
    assert fake.calls == []
