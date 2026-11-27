"""Requests the LLM route refuses before it reserves anything: no database is needed.

`connect` is replaced by a function that fails the test, so a refusal that opened a connection
(or went on to call the provider) would be caught.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fakes import FakeLlm
from fastapi.testclient import TestClient

from assistant_gateway.main import create_app
from assistant_gateway.pricing import Usage
from assistant_gateway.providers.llm import LlmResult

BODY: dict[str, Any] = {
    "use_case": "person_add",
    "end_user_id": "user-1",
    "system": "Be brief.",
    "messages": [{"role": "user", "content": "hello"}],
}


@pytest.fixture
def fake() -> FakeLlm:
    return FakeLlm(LlmResult("x", Usage(1, 1), "end_turn", "claude-haiku-4-5"))


@pytest.fixture
def no_db_client(fake: FakeLlm, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    def _no_connection(*_a: object, **_k: object) -> None:
        raise AssertionError("a refused request must not open a database connection")

    monkeypatch.setattr("assistant_gateway.routes.llm.connect", _no_connection)
    with TestClient(create_app(llm=fake)) as c:
        yield c


def post(client: TestClient, headers: dict[str, str], **over: object) -> httpx.Response:
    body = {**BODY, **over}
    return client.post(
        "/v1/llm/messages", json={k: v for k, v in body.items() if v is not None}, headers=headers
    )


def test_requires_a_known_key(no_db_client: TestClient, fake: FakeLlm) -> None:
    assert no_db_client.post("/v1/llm/messages", json=BODY).status_code == 401
    r = no_db_client.post("/v1/llm/messages", json=BODY, headers={"Authorization": "Bearer wrong"})
    assert r.json()["code"] == "auth.unauthenticated"
    assert fake.calls == []


def test_unknown_use_case_is_422(
    no_db_client: TestClient, auth: dict[str, str], fake: FakeLlm
) -> None:
    r = post(no_db_client, auth, use_case="nope")
    assert r.status_code == 422
    assert r.json()["code"] == "unknown_use_case"
    assert fake.calls == []


def test_input_too_large_is_413(
    no_db_client: TestClient, auth: dict[str, str], fake: FakeLlm
) -> None:
    # `short` allows 50 characters across system, context and messages.
    r = post(
        no_db_client,
        auth,
        use_case="short",
        system="s" * 20,
        context="c" * 20,
        messages=[{"role": "user", "content": "m" * 11}],
    )
    assert r.status_code == 413
    assert r.json()["code"] == "input_too_large"
    assert fake.calls == []


def test_unpriced_model_is_422_on_a_per_request_use_case(
    no_db_client: TestClient, auth: dict[str, str], fake: FakeLlm
) -> None:
    r = post(no_db_client, auth, use_case="trial", model="gpt-whatever")
    assert r.status_code == 422
    assert r.json()["code"] == "model_not_allowed"
    assert fake.calls == []


def test_per_request_use_case_needs_a_model(
    no_db_client: TestClient, auth: dict[str, str], fake: FakeLlm
) -> None:
    r = post(no_db_client, auth, use_case="trial")
    assert r.status_code == 422
    assert r.json()["code"] == "model_required"
    assert fake.calls == []


@pytest.mark.parametrize(
    "over",
    [
        {"messages": []},
        {"messages": [{"role": "user", "content": "x"}] * 41},
        {"messages": [{"role": "system", "content": "x"}]},
        {"messages": [{"role": "user", "content": "x" * 20001}]},
        {"end_user_id": ""},
        {"end_user_id": "u" * 129},
        {"unexpected": 1},
    ],
    ids=[
        "no_messages",
        "41_messages",
        "bad_role",
        "long_content",
        "empty_user",
        "long_user",
        "extra_field",
    ],
)
def test_invalid_bodies_are_422(
    no_db_client: TestClient, auth: dict[str, str], fake: FakeLlm, over: dict[str, Any]
) -> None:
    r = post(no_db_client, auth, **over)
    assert r.status_code == 422
    assert r.json()["code"] == "validation.invalid_request"
    assert fake.calls == []
