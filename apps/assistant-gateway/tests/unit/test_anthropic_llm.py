from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import anthropic
import httpx2
import pytest

from assistant_gateway.pricing import Usage
from assistant_gateway.providers import ProviderRejected, ProviderUncertain
from assistant_gateway.providers.anthropic_llm import (
    EFFORT_MODELS,
    AnthropicProvider,
    LazyAnthropicProvider,
)
from assistant_gateway.providers.llm import LlmResult

REQUEST = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


class StubMessages:
    def __init__(self, outcome: object) -> None:
        self.outcome = outcome
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


def _response(**over: object) -> SimpleNamespace:
    usage = SimpleNamespace(
        input_tokens=1000,
        output_tokens=200,
        cache_read_input_tokens=None,
        cache_creation_input_tokens=30,
    )
    base: dict[str, Any] = {
        "content": [SimpleNamespace(type="text", text='{"ok":')],
        "usage": usage,
        "stop_reason": "end_turn",
        "model": "claude-haiku-4-5",
    }
    return SimpleNamespace(**{**base, **over})


def _provider(outcome: object = None) -> tuple[AnthropicProvider, StubMessages]:
    messages = StubMessages(_response() if outcome is None else outcome)
    return AnthropicProvider("k", client=SimpleNamespace(messages=messages)), messages


def _complete(provider: AnthropicProvider, **over: object) -> LlmResult:
    args: dict[str, Any] = {
        "model": "claude-haiku-4-5",
        "system": "SYS",
        "context": None,
        "messages": [{"role": "user", "content": "hi"}],
        "output_schema": None,
        "max_output_tokens": 500,
        "effort": None,
    }
    return provider.complete(**{**args, **over})


def test_system_is_cached_and_context_follows() -> None:
    provider, stub = _provider()
    _complete(provider, context="CTX")
    kwargs = stub.calls[0]
    assert kwargs["system"][0] == {
        "type": "text",
        "text": "SYS",
        "cache_control": {"type": "ephemeral"},
    }
    assert kwargs["system"][1] == {"type": "text", "text": "CTX"}
    assert kwargs["max_tokens"] == 500
    assert kwargs["messages"] == [{"role": "user", "content": "hi"}]


def test_no_context_sends_only_the_cached_system_block() -> None:
    provider, stub = _provider()
    _complete(provider)
    assert len(stub.calls[0]["system"]) == 1


def test_schema_becomes_a_json_schema_output_format() -> None:
    provider, stub = _provider()
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}}
    _complete(provider, output_schema=schema)
    assert stub.calls[0]["output_config"] == {"format": {"type": "json_schema", "schema": schema}}


def test_no_schema_and_no_effort_sends_no_output_config() -> None:
    provider, stub = _provider()
    _complete(provider)
    assert "output_config" not in stub.calls[0]


def test_effort_only_on_models_that_take_it() -> None:
    assert EFFORT_MODELS == {"claude-sonnet-5-5", "claude-opus-5-5"}
    provider, stub = _provider()
    _complete(provider, model="claude-haiku-4-5", effort="low")
    assert "output_config" not in stub.calls[0]
    _complete(provider, model="claude-sonnet-5-5", effort="low")
    assert stub.calls[1]["output_config"] == {"effort": "low"}
    _complete(provider, model="claude-opus-5-5", effort="high", output_schema={"type": "object"})
    assert stub.calls[2]["output_config"]["effort"] == "high"
    assert stub.calls[2]["output_config"]["format"]["type"] == "json_schema"


def test_output_config_is_a_real_sdk_parameter() -> None:
    # The kwargs are not just recorded by a stub: the installed SDK accepts them by name.
    import inspect

    params = inspect.signature(anthropic.Anthropic(api_key="x").messages.create).parameters
    assert "output_config" in params


def test_no_thinking_and_no_fallbacks_sent() -> None:
    provider, stub = _provider()
    _complete(provider, model="claude-opus-5-5", effort="max", output_schema={"type": "object"})
    assert "thinking" not in stub.calls[0] and "fallbacks" not in stub.calls[0]
    assert set(stub.calls[0]) <= {"model", "max_tokens", "system", "messages", "output_config"}


def test_result_carries_text_usage_stop_reason_and_model() -> None:
    provider, _ = _provider()
    result = _complete(provider)
    assert result.text == '{"ok":'
    # A None cache count from the API reads as zero.
    assert result.usage == Usage(1000, 200, 0, 30)
    assert result.stop_reason == "end_turn"
    assert result.model == "claude-haiku-4-5"


def test_text_blocks_are_joined_and_other_blocks_ignored() -> None:
    blocks = [
        SimpleNamespace(type="thinking", thinking="x"),
        SimpleNamespace(type="text", text="a"),
        SimpleNamespace(type="text", text="b"),
    ]
    provider, _ = _provider(_response(content=blocks))
    assert _complete(provider).text == "ab"


def _status_error(cls: type[anthropic.APIStatusError], status: int) -> anthropic.APIStatusError:
    return cls("boom", response=httpx2.Response(status, request=REQUEST), body=None)


def test_timeout_maps_to_uncertain() -> None:
    provider, _ = _provider(anthropic.APITimeoutError(REQUEST))
    with pytest.raises(ProviderUncertain) as caught:
        _complete(provider)
    assert caught.value.code == "timeout"


def test_connection_error_maps_to_uncertain() -> None:
    provider, _ = _provider(anthropic.APIConnectionError(request=REQUEST))
    with pytest.raises(ProviderUncertain):
        _complete(provider)


def test_rate_limit_maps_to_rejected() -> None:
    provider, _ = _provider(_status_error(anthropic.RateLimitError, 429))
    with pytest.raises(ProviderRejected) as caught:
        _complete(provider)
    assert caught.value.code == "http_429"


@pytest.mark.parametrize(
    ("cls", "status"),
    [
        (anthropic.BadRequestError, 400),
        (anthropic.AuthenticationError, 401),
        (anthropic.PermissionDeniedError, 403),
        (anthropic.NotFoundError, 404),
        (anthropic.ConflictError, 409),
        (anthropic.UnprocessableEntityError, 422),
        (anthropic.APIStatusError, 413),
    ],
)
def test_4xx_maps_to_rejected(cls: type[anthropic.APIStatusError], status: int) -> None:
    provider, _ = _provider(_status_error(cls, status))
    with pytest.raises(ProviderRejected):
        _complete(provider)


def test_overloaded_529_maps_to_rejected() -> None:
    provider, _ = _provider(_status_error(anthropic.OverloadedError, 529))
    with pytest.raises(ProviderRejected) as caught:
        _complete(provider)
    assert caught.value.code == "overloaded"


@pytest.mark.parametrize(
    ("cls", "status"),
    [(anthropic.InternalServerError, 500), (anthropic.APIStatusError, 502)],
)
def test_other_5xx_maps_to_uncertain(cls: type[anthropic.APIStatusError], status: int) -> None:
    provider, _ = _provider(_status_error(cls, status))
    with pytest.raises(ProviderUncertain):
        _complete(provider)


def test_the_real_client_is_built_with_the_fixed_timeout_and_no_retries() -> None:
    client = AnthropicProvider("k")._client
    assert client.timeout == 30.0
    # A retry would hide whether the first attempt was billed, so the SDK must not retry.
    assert client.max_retries == 0


def test_lazy_provider_boots_without_a_key_and_rejects_the_call() -> None:
    lazy = LazyAnthropicProvider("ANTHROPIC_API_KEY", environ={})
    with pytest.raises(ProviderRejected) as caught:
        _complete(lazy)  # type: ignore[arg-type]
    assert caught.value.code == "not_configured"


def test_lazy_provider_builds_once_from_the_environment() -> None:
    lazy = LazyAnthropicProvider("MY_KEY", environ={"MY_KEY": "sk-test"})
    first = lazy._built()
    assert lazy._built() is first
