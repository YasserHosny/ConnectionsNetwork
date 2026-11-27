from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

import httpx
import psycopg
import pytest
from fakes import FakeLlm
from fastapi.testclient import TestClient

from assistant_gateway import db
from assistant_gateway.main import create_app
from assistant_gateway.pricing import Usage
from assistant_gateway.providers import ProviderRejected, ProviderUncertain
from assistant_gateway.providers.llm import LlmResult

OK = LlmResult('{"ok":true}', Usage(1000, 200), "end_turn", "claude-haiku-4-5")
SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}}


@pytest.fixture(autouse=True)
def _empty_ledger(database_url: str) -> None:
    with db.connect(database_url, autocommit=True) as c:
        c.execute("truncate assistant_gateway.ledger_entry")


def post_llm(fake: FakeLlm, headers: dict[str, str], **over: object) -> httpx.Response:
    body: dict[str, Any] = {
        "use_case": "person_add",
        "end_user_id": "user-1",
        "system": "Be brief.",
        "messages": [{"role": "user", "content": "hello"}],
        "output_schema": SCHEMA,
        **over,
    }
    body = {k: v for k, v in body.items() if v is not None}
    with TestClient(create_app(llm=fake)) as client:
        return client.post("/v1/llm/messages", json=body, headers=headers)


def ledger_rows(conn: psycopg.Connection[Any]) -> list[tuple[str, Decimal | None]]:
    return conn.execute(
        "select status, actual_usd from assistant_gateway.ledger_entry order by created_at"
    ).fetchall()


def test_happy_path_settles_actual_cost(
    auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    fake = FakeLlm(OK)
    r = post_llm(fake, auth)
    assert r.status_code == 200
    body = r.json()
    assert body["output"] == {"ok": True}
    assert body["cost_usd"] == 0.002
    assert body["model"] == "claude-haiku-4-5"
    assert body["usage"] == {
        "input_tokens": 1000,
        "output_tokens": 200,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    }
    assert body["budget"] == {"used_usd": 0.002, "cap_usd": 5.0, "warning": False}
    assert ledger_rows(conn) == [("settled", Decimal("0.002000"))]


def test_provider_is_called_with_the_use_case_settings(auth: dict[str, str]) -> None:
    fake = FakeLlm(OK)
    post_llm(fake, auth, context="CTX")
    assert fake.calls == [
        {
            "model": "claude-haiku-4-5",
            "system": "Be brief.",
            "context": "CTX",
            "messages": [{"role": "user", "content": "hello"}],
            "output_schema": SCHEMA,
            "max_output_tokens": 2000,
            "effort": None,
        }
    ]


def test_input_exactly_at_the_limit_is_accepted(auth: dict[str, str]) -> None:
    # `short` allows 50 characters across system, context and messages.
    r = post_llm(
        FakeLlm(OK),
        auth,
        use_case="short",
        system="s" * 20,
        context="c" * 20,
        messages=[{"role": "user", "content": "m" * 10}],
    )
    assert r.status_code == 200


def test_without_a_schema_the_output_is_the_text(auth: dict[str, str]) -> None:
    ok = LlmResult("plain words", Usage(10, 5), "end_turn", "claude-haiku-4-5")
    r = post_llm(FakeLlm(ok), auth, output_schema=None)
    assert r.status_code == 200
    assert r.json()["output"] == "plain words"


def test_budget_exhausted_never_calls_provider(
    auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    fake = FakeLlm(OK)
    r = post_llm(fake, auth, use_case="capped")  # cap 0.01, worst case is about 0.015
    assert r.status_code == 429
    assert r.json()["code"] == "budget_exhausted"
    assert r.json()["details"] == {"cap": "use_case_monthly"}
    assert set(r.json()) == {"code", "message", "details", "trace_id"}
    assert fake.calls == []
    assert ledger_rows(conn) == []


def test_timeout_keeps_reservation_counting(
    auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    r = post_llm(FakeLlm(ProviderUncertain("timeout")), auth)
    assert r.status_code == 502
    assert r.json()["code"] == "provider_unavailable"
    rows = conn.execute(
        "select status, reserved_usd, error_code from assistant_gateway.ledger_entry"
    ).fetchall()
    assert [(s, e) for s, _, e in rows] == [("unknown", "timeout")]
    assert rows[0][1] > 0


def test_rejected_releases(auth: dict[str, str], conn: psycopg.Connection[Any]) -> None:
    r = post_llm(FakeLlm(ProviderRejected("http_429")), auth)
    assert r.status_code == 502
    assert r.json()["code"] == "provider_unavailable"
    assert ledger_rows(conn) == [("released", None)]


def test_unexpected_provider_failure_keeps_the_reservation(
    auth: dict[str, str], conn: psycopg.Connection[Any]
) -> None:
    fake = FakeLlm(RuntimeError("boom"))
    with TestClient(create_app(llm=fake), raise_server_exceptions=False) as client:
        r = client.post(
            "/v1/llm/messages",
            json={
                "use_case": "person_add",
                "end_user_id": "u",
                "system": "s",
                "messages": [{"role": "user", "content": "x"}],
            },
            headers=auth,
        )
    assert r.status_code == 500
    assert [s for s, _ in ledger_rows(conn)] == ["unknown"]


def test_refusal_is_settled_and_502(auth: dict[str, str], conn: psycopg.Connection[Any]) -> None:
    refused = LlmResult("", Usage(100, 0), "refusal", "claude-haiku-4-5")
    r = post_llm(FakeLlm(refused), auth)
    assert r.status_code == 502
    assert r.json()["code"] == "provider_refused"
    assert ledger_rows(conn) == [("settled", Decimal("0.000100"))]


@pytest.mark.parametrize(
    "result",
    [
        LlmResult('{"ok":tr', Usage(100, 2000), "max_tokens", "claude-haiku-4-5"),
        LlmResult("not json at all", Usage(100, 10), "end_turn", "claude-haiku-4-5"),
    ],
    ids=["max_tokens", "invalid_json"],
)
def test_bad_output_is_settled_and_502(
    auth: dict[str, str], conn: psycopg.Connection[Any], result: LlmResult
) -> None:
    r = post_llm(FakeLlm(result), auth)
    assert r.status_code == 502
    assert r.json()["code"] == "provider_bad_output"
    ((status, actual),) = ledger_rows(conn)
    assert status == "settled" and actual > 0


def test_max_tokens_without_a_schema_is_bad_output_too(auth: dict[str, str]) -> None:
    cut = LlmResult("half a sen", Usage(100, 2000), "max_tokens", "claude-haiku-4-5")
    r = post_llm(FakeLlm(cut), auth, output_schema=None)
    assert r.status_code == 502
    assert r.json()["code"] == "provider_bad_output"


def test_model_override_only_for_per_request_use_case(
    auth: dict[str, str],
) -> None:
    # A fixed-model use case ignores the field and runs its configured model.
    fixed = FakeLlm(OK)
    assert post_llm(fixed, auth, model="claude-sonnet-5-5").status_code == 200
    assert fixed.calls[0]["model"] == "claude-haiku-4-5"
    # A per-request use case runs the requested model, with the use case's effort.
    trial = FakeLlm(LlmResult('{"ok":true}', Usage(1000, 200), "end_turn", "claude-sonnet-5-5"))
    r = post_llm(trial, auth, use_case="trial", model="claude-sonnet-5-5")
    assert r.status_code == 200
    assert trial.calls[0]["model"] == "claude-sonnet-5-5"
    assert trial.calls[0]["effort"] == "low"
    assert trial.calls[0]["max_output_tokens"] == 1000
    assert r.json()["model"] == "claude-sonnet-5-5"
    assert r.json()["cost_usd"] == 0.006  # 1000 * 3 + 200 * 15 per million


def test_rate_limit_counts_llm_calls_per_app_key(auth: dict[str, str]) -> None:
    fake = FakeLlm(OK)
    body = {
        "use_case": "person_add",
        "end_user_id": "u",
        "system": "s",
        "messages": [{"role": "user", "content": "x"}],
    }
    with TestClient(create_app(llm=fake)) as client:
        codes = [
            client.post("/v1/llm/messages", json=body, headers=auth).status_code for _ in range(61)
        ]
    assert codes[:60] == [200] * 60
    assert codes[60] == 429


def test_prompt_text_never_logged(
    auth: dict[str, str], caplog: pytest.LogCaptureFixture, capfd: pytest.CaptureFixture[str]
) -> None:
    marker = "MARKER-7f3a"
    answer = LlmResult(
        f'{{"ok":true,"m":"{marker}"}}', Usage(10, 5), "end_turn", "claude-haiku-4-5"
    )
    fake = FakeLlm(answer)
    app = create_app(llm=fake)  # configure_logging() replaces the root handlers; re-attach caplog
    logging.getLogger().addHandler(caplog.handler)
    caplog.set_level(logging.DEBUG)
    body = {
        "use_case": "person_add",
        "end_user_id": "user-1",
        "system": f"sys {marker}",
        "context": f"ctx {marker}",
        "messages": [{"role": "user", "content": f"msg {marker}"}],
        "output_schema": SCHEMA,
    }
    with TestClient(app) as client:
        assert client.post("/v1/llm/messages", json=body, headers=auth).status_code == 200
        # The refusal paths log too: a 502 and a 429.
        fake.outcome = ProviderUncertain("timeout")
        assert client.post("/v1/llm/messages", json=body, headers=auth).status_code == 502
    assert marker not in caplog.text
    assert marker not in capfd.readouterr().out
    lines = [r for r in caplog.records if r.getMessage() == "llm call"]
    assert [r.__dict__["status"] for r in lines] == [200, 502]
    ok = lines[0].__dict__
    assert (ok["app"], ok["use_case"], ok["model"], ok["cost_usd"]) == (
        "connections",
        "person_add",
        "claude-haiku-4-5",
        0.000035,
    )
    assert ok["trace_id"]
    assert lines[1].__dict__["error_code"] == "provider_unavailable"


def test_without_an_api_key_the_app_boots_and_the_call_is_released(
    auth: dict[str, str], conn: psycopg.Connection[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    body = {
        "use_case": "person_add",
        "end_user_id": "u",
        "system": "s",
        "messages": [{"role": "user", "content": "x"}],
    }
    with TestClient(create_app()) as client:  # the default, lazily built Anthropic provider
        r = client.post("/v1/llm/messages", json=body, headers=auth)
    assert r.status_code == 502
    assert r.json()["code"] == "provider_unavailable"
    assert ledger_rows(conn) == [("released", None)]
