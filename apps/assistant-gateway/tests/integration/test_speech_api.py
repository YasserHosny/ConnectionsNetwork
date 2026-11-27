from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

import httpx
import psycopg
import pytest
from audio_samples import mp4_aac, webm_opus_no_duration
from fakes import FakeSpeech
from fastapi.testclient import TestClient

from assistant_gateway import db
from assistant_gateway.main import create_app
from assistant_gateway.providers import ProviderRejected, ProviderUncertain
from assistant_gateway.providers.speech import SpeechResult

WEBM_3S = webm_opus_no_duration(3.0)
OK = SpeechResult("marhaba ya basha")


@pytest.fixture(autouse=True)
def _empty_ledger(database_url: str) -> None:
    with db.connect(database_url, autocommit=True) as c:
        c.execute("truncate assistant_gateway.ledger_entry")


def post_speech(
    speech: dict[str, FakeSpeech] | None,
    headers: dict[str, str],
    audio: bytes = WEBM_3S,
    mime: str = "audio/webm",
    **fields: str,
) -> httpx.Response:
    data = {"use_case": "dictate", "end_user_id": "user-1", **fields}
    with TestClient(create_app(speech=speech)) as client:
        return client.post(
            "/v1/speech/transcribe",
            data=data,
            files={"file": ("recording", audio, mime)},
            headers=headers,
        )


def rows(conn: psycopg.Connection[Any]) -> list[tuple[str, str, Decimal | None, Decimal | None]]:
    return conn.execute(
        "select status, kind, actual_usd, audio_seconds"
        " from assistant_gateway.ledger_entry order by created_at"
    ).fetchall()


def test_happy_path_prices_by_measured_duration(
    auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    fake = FakeSpeech(OK)
    r = post_speech({"openai": fake}, auth)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"text", "duration_seconds", "provider", "cost_usd", "budget"}
    assert body["text"] == "marhaba ya basha"
    assert body["provider"] == "openai"
    assert 2.9 <= body["duration_seconds"] <= 3.1
    # 0.006 USD a minute, rounded up: 3 s is 0.0003.
    assert 0.0003 <= body["cost_usd"] <= 0.00031
    assert body["budget"] == {"used_usd": body["cost_usd"], "cap_usd": 5.0, "warning": False}
    ((status, kind, actual, seconds),) = rows(conn)
    assert (status, kind) == ("settled", "speech")
    assert float(actual) == body["cost_usd"]
    assert float(seconds) == body["duration_seconds"]


def test_cost_is_exactly_the_rate_for_the_duration(
    auth: dict[str, str], conn: psycopg.Connection[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "assistant_gateway.routes.speech.duration_seconds", lambda _data: Decimal("3.00")
    )
    r = post_speech({"openai": FakeSpeech(OK)}, auth)
    assert r.json()["cost_usd"] == 0.0003
    assert rows(conn) == [("settled", "speech", Decimal("0.000300"), Decimal("3.00"))]


def test_mp4_is_accepted(auth: dict[str, str]) -> None:
    fake = FakeSpeech(OK)
    assert (
        post_speech({"openai": fake}, auth, audio=mp4_aac(3.0), mime="audio/mp4").status_code == 200
    )


def test_provider_gets_the_audio_mime_and_use_case_language(auth: dict[str, str]) -> None:
    fake = FakeSpeech(OK)
    post_speech({"openai": fake}, auth)
    assert fake.calls == [(WEBM_3S, "audio/webm", "ar")]


def test_language_field_overrides_the_use_case_language(auth: dict[str, str]) -> None:
    fake = FakeSpeech(OK)
    post_speech({"openai": fake}, auth, language="en")
    assert fake.calls[0][2] == "en"


def test_browser_mode_is_409(auth: dict[str, str], conn: psycopg.Connection[Any]) -> None:
    fake = FakeSpeech(OK)
    r = post_speech({"openai": fake}, auth, use_case="person_add")
    assert r.status_code == 409
    assert r.json()["code"] == "speech_mode_browser"
    assert set(r.json()) == {"code", "message", "details", "trace_id"}
    assert fake.calls == [] and rows(conn) == []


def test_unknown_use_case_is_422(auth: dict[str, str]) -> None:
    r = post_speech({"openai": FakeSpeech(OK)}, auth, use_case="nope")
    assert (r.status_code, r.json()["code"]) == (422, "unknown_use_case")


def test_a_missing_key_is_401() -> None:
    r = post_speech({"openai": FakeSpeech(OK)}, {})
    assert r.status_code == 401


def test_a_missing_file_is_422(auth: dict[str, str]) -> None:
    with TestClient(create_app(speech={"openai": FakeSpeech(OK)})) as client:
        r = client.post(
            "/v1/speech/transcribe",
            data={"use_case": "dictate", "end_user_id": "u"},
            headers=auth,
        )
    assert r.status_code == 422


def test_too_long_refused_before_reserve(
    auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    fake = FakeSpeech(OK)
    r = post_speech({"openai": fake}, auth, audio=webm_opus_no_duration(61.0))  # max is 60
    assert r.status_code == 413
    assert r.json()["code"] == "audio_too_long"
    assert fake.calls == [] and rows(conn) == []


def test_exactly_the_maximum_is_accepted(auth: dict[str, str]) -> None:
    assert (
        post_speech({"openai": FakeSpeech(OK)}, auth, audio=webm_opus_no_duration(59.0)).status_code
        == 200
    )


def test_oversized_upload_is_413_before_anything_else(
    auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    fake = FakeSpeech(OK)
    r = post_speech({"openai": fake}, auth, audio=b"\0" * (10 * 1024 * 1024 + 1))
    assert r.status_code == 413
    assert r.json()["code"] == "audio_too_large"
    assert fake.calls == [] and rows(conn) == []


def test_unsupported_audio_is_415(auth: dict[str, str], conn: psycopg.Connection[Any]) -> None:
    fake = FakeSpeech(OK)
    r = post_speech({"openai": fake}, auth, audio=b"definitely not audio")
    assert r.status_code == 415
    assert r.json()["code"] == "unsupported_audio"
    assert fake.calls == [] and rows(conn) == []


def test_budget_exhausted_never_calls_provider(
    auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    fake = FakeSpeech(OK)
    r = post_speech({"openai": fake}, auth, use_case="dictate_capped")  # cap 0.0001, cost 0.0003
    assert r.status_code == 429
    assert r.json()["code"] == "budget_exhausted"
    assert r.json()["details"] == {"cap": "use_case_monthly"}
    assert fake.calls == [] and rows(conn) == []


def test_timeout_marks_unknown(auth: dict[str, str], conn: psycopg.Connection[Any]) -> None:
    r = post_speech({"openai": FakeSpeech(ProviderUncertain("timeout"))}, auth)
    assert r.status_code == 502
    assert r.json()["code"] == "provider_unavailable"
    entries = conn.execute(
        "select status, reserved_usd, error_code from assistant_gateway.ledger_entry"
    ).fetchall()
    assert [(s, e) for s, _, e in entries] == [("unknown", "timeout")]
    assert entries[0][1] > 0


def test_rejected_releases(auth: dict[str, str], conn: psycopg.Connection[Any]) -> None:
    r = post_speech({"openai": FakeSpeech(ProviderRejected("http_429"))}, auth)
    assert r.status_code == 502
    assert r.json()["code"] == "provider_unavailable"
    assert [s for s, *_ in rows(conn)] == ["released"]


def test_unexpected_provider_failure_keeps_the_reservation(
    auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    app = create_app(speech={"openai": FakeSpeech(RuntimeError("boom"))})
    with TestClient(app, raise_server_exceptions=False) as client:
        r = client.post(
            "/v1/speech/transcribe",
            data={"use_case": "dictate", "end_user_id": "u"},
            files={"file": ("a.webm", WEBM_3S, "audio/webm")},
            headers=auth,
        )
    assert r.status_code == 500
    assert [s for s, *_ in rows(conn)] == ["unknown"]


def test_per_request_provider_is_honoured_when_priced_and_configured(
    auth: dict[str, str],
) -> None:
    fake = FakeSpeech(OK, name="elevenlabs")
    r = post_speech(
        {"openai": FakeSpeech(OK), "elevenlabs": fake},
        auth,
        use_case="dictate_trial",
        provider="elevenlabs",
    )
    assert r.status_code == 200
    assert r.json()["provider"] == "elevenlabs"
    assert len(fake.calls) == 1


def test_per_request_without_a_provider_is_422(auth: dict[str, str]) -> None:
    r = post_speech({"openai": FakeSpeech(OK)}, auth, use_case="dictate_trial")
    assert (r.status_code, r.json()["code"]) == (422, "provider_required")


@pytest.mark.parametrize("name", ["whisper-x", "anthropic", ""])
def test_per_request_provider_not_available_is_422(
    auth: dict[str, str], conn: psycopg.Connection[Any], name: str
) -> None:
    r = post_speech({"openai": FakeSpeech(OK)}, auth, use_case="dictate_trial", provider=name)
    assert r.status_code == 422
    assert r.json()["code"] in {"provider_not_allowed", "provider_required"}
    assert rows(conn) == []


def test_provider_priced_but_without_an_adapter_is_422(auth: dict[str, str]) -> None:
    # elevenlabs is priced and configured, but this registry has no adapter for it.
    r = post_speech(
        {"openai": FakeSpeech(OK)}, auth, use_case="dictate_trial", provider="elevenlabs"
    )
    assert (r.status_code, r.json()["code"]) == (422, "provider_not_allowed")


def test_provider_field_is_ignored_on_a_fixed_provider_use_case(auth: dict[str, str]) -> None:
    openai, other = FakeSpeech(OK), FakeSpeech(OK, name="elevenlabs")
    r = post_speech({"openai": openai, "elevenlabs": other}, auth, provider="elevenlabs")
    assert r.status_code == 200
    assert r.json()["provider"] == "openai"
    assert other.calls == []


def test_fixed_provider_without_an_adapter_is_502_before_reserving(
    auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    r = post_speech({"openai": FakeSpeech(OK)}, auth, use_case="dictate_eleven")
    assert (r.status_code, r.json()["code"]) == (502, "provider_unavailable")
    assert rows(conn) == []


def test_rate_limit_counts_speech_calls_per_app_key(auth: dict[str, str]) -> None:
    data = {"use_case": "person_add", "end_user_id": "u"}  # 409 each time: cheap, still counted
    with TestClient(create_app(speech={})) as client:
        codes = [
            client.post(
                "/v1/speech/transcribe",
                data=data,
                files={"file": ("a", b"x", "audio/webm")},
                headers=auth,
            ).status_code
            for _ in range(61)
        ]
    assert codes[:60] == [409] * 60
    assert codes[60] == 429


def test_transcript_and_audio_never_logged(
    auth: dict[str, str], caplog: pytest.LogCaptureFixture, capfd: pytest.CaptureFixture[str]
) -> None:
    marker = "MARKER-7f3a"
    fake = FakeSpeech(SpeechResult(f"hello {marker}"))
    app = create_app(speech={"openai": fake})  # configure_logging() replaces the root handlers
    logging.getLogger().addHandler(caplog.handler)
    caplog.set_level(logging.DEBUG)
    with TestClient(app) as client:
        r = client.post(
            "/v1/speech/transcribe",
            data={"use_case": "dictate", "end_user_id": "user-1"},
            files={"file": (f"{marker}.webm", WEBM_3S, "audio/webm")},
            headers=auth,
        )
        assert r.status_code == 200
        fake.outcome = ProviderUncertain("timeout")
        assert (
            client.post(
                "/v1/speech/transcribe",
                data={"use_case": "dictate", "end_user_id": "user-1"},
                files={"file": ("a.webm", WEBM_3S, "audio/webm")},
                headers=auth,
            ).status_code
            == 502
        )
    assert marker not in caplog.text
    assert marker not in capfd.readouterr().out
    lines = [r for r in caplog.records if r.getMessage() == "speech call"]
    assert [r.__dict__["status"] for r in lines] == [200, 502]
    ok = lines[0].__dict__
    assert (ok["app"], ok["use_case"], ok["provider"]) == ("connections", "dictate", "openai")
    assert ok["cost_usd"] > 0 and ok["trace_id"]
    assert lines[1].__dict__["error_code"] == "provider_unavailable"


def test_without_an_api_key_the_app_boots_and_the_call_is_released(
    auth: dict[str, str], conn: psycopg.Connection[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with TestClient(create_app()) as client:  # the default, lazily built registry
        r = client.post(
            "/v1/speech/transcribe",
            data={"use_case": "dictate", "end_user_id": "u"},
            files={"file": ("a.webm", WEBM_3S, "audio/webm")},
            headers=auth,
        )
    assert r.status_code == 502
    assert r.json()["code"] == "provider_unavailable"
    assert [s for s, *_ in rows(conn)] == ["released"]


def test_the_registry_key_not_the_adapters_name_labels_the_call(
    auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    # Fixed provider: key "openai", adapter that calls itself something else.
    r = post_speech({"openai": FakeSpeech(OK, name="impostor")}, auth)
    assert (r.status_code, r.json()["provider"]) == (200, "openai")
    # Per-request: requested key "elevenlabs", adapter named "openai".
    r = post_speech(
        {"elevenlabs": FakeSpeech(OK, name="openai")},
        auth,
        use_case="dictate_trial",
        provider="elevenlabs",
    )
    assert (r.status_code, r.json()["provider"]) == (200, "elevenlabs")
    models = conn.execute(
        "select model from assistant_gateway.ledger_entry order by created_at"
    ).fetchall()
    assert models == [("openai",), ("elevenlabs",)]
