"""The Claude adapter, on the official `anthropic` SDK.

Each model takes only the knobs it supports: `effort` is sent to the models in EFFORT_MODELS and
to no other (Haiku 4.5 rejects it). No `thinking` parameter is sent, so each model keeps its own
default, and there are no server-side `fallbacks`: every model a request can run on is priced.

The client is built with `max_retries=0`: a retry would hide whether the first attempt was billed
(see MAX_RETRIES).

SDK failures become the two errors the route understands (see `providers/__init__`).
"""

from __future__ import annotations

import os
import threading
from collections.abc import Mapping
from typing import Any, Protocol

import anthropic

from assistant_gateway.pricing import Usage
from assistant_gateway.providers import ProviderRejected, ProviderUncertain
from assistant_gateway.providers.llm import LlmResult

EFFORT_MODELS = frozenset({"claude-sonnet-5-5", "claude-opus-5-5"})
TIMEOUT_SECONDS = 30.0
# The SDK would retry timeouts, dropped connections, 408/409/429 and 5xx, and only the last
# attempt's error reaches us. A first attempt that timed out (and may have been billed), followed
# by a retry answered 429 or 529, would read as "rejected", and the route would release the
# reservation. So the SDK never retries; the calling app decides whether to try again.
MAX_RETRIES = 0


class _MessagesClient(Protocol):
    messages: Any


class AnthropicProvider:
    def __init__(self, api_key: str, *, client: _MessagesClient | None = None) -> None:
        # `client` is for tests: anything with `.messages.create`.
        self._client = client or anthropic.Anthropic(
            api_key=api_key, timeout=TIMEOUT_SECONDS, max_retries=MAX_RETRIES
        )

    def complete(
        self,
        *,
        model: str,
        system: str,
        context: str | None,
        messages: list[dict[str, str]],
        output_schema: dict[str, Any] | None,
        max_output_tokens: int,
        effort: str | None,
    ) -> LlmResult:
        # The stable `system` is the cached prefix; the per-request context follows it uncached.
        system_blocks: list[dict[str, Any]] = [
            {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
        ]
        if context:
            system_blocks.append({"type": "text", "text": context})
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_output_tokens,
            "system": system_blocks,
            "messages": messages,
        }
        output_config: dict[str, Any] = {}
        if output_schema is not None:
            output_config["format"] = {"type": "json_schema", "schema": output_schema}
        if effort is not None and model in EFFORT_MODELS:
            output_config["effort"] = effort
        if output_config:
            kwargs["output_config"] = output_config
        try:
            response = self._client.messages.create(**kwargs)
        except anthropic.APIError as exc:
            raise _map_error(exc) from None
        return _to_result(response)


class LazyAnthropicProvider:
    """Builds the real provider on first use, so an app boots without a key (tests, local dev).

    A missing key then fails the call as `ProviderRejected("not_configured")`: nothing was sent,
    so the route releases the reservation and answers 502 provider_unavailable.
    """

    def __init__(self, api_key_env: str, environ: Mapping[str, str] | None = None) -> None:
        self._env_name = api_key_env
        self._environ = os.environ if environ is None else environ
        self._provider: AnthropicProvider | None = None
        self._lock = threading.Lock()

    def complete(
        self,
        *,
        model: str,
        system: str,
        context: str | None,
        messages: list[dict[str, str]],
        output_schema: dict[str, Any] | None,
        max_output_tokens: int,
        effort: str | None,
    ) -> LlmResult:
        return self._built().complete(
            model=model,
            system=system,
            context=context,
            messages=messages,
            output_schema=output_schema,
            max_output_tokens=max_output_tokens,
            effort=effort,
        )

    def _built(self) -> AnthropicProvider:
        with self._lock:
            if self._provider is None:
                key = self._environ.get(self._env_name)
                if not key:
                    raise ProviderRejected("not_configured")
                self._provider = AnthropicProvider(key)
            return self._provider


def _map_error(exc: anthropic.APIError) -> ProviderRejected | ProviderUncertain:
    if isinstance(exc, anthropic.APITimeoutError):
        return ProviderUncertain("timeout")
    if isinstance(exc, anthropic.APIConnectionError):
        return ProviderUncertain("connection_error")
    if isinstance(exc, anthropic.APIStatusError):
        # 529 first: OverloadedError is an InternalServerError, but the request was not processed.
        if isinstance(exc, anthropic.OverloadedError):
            return ProviderRejected("overloaded")
        if exc.status_code < 500:
            return ProviderRejected(f"http_{exc.status_code}")
        return ProviderUncertain(f"http_{exc.status_code}")
    # Any other SDK error (e.g. an unparseable body): we cannot tell whether it was billed.
    return ProviderUncertain("provider_error")


def _to_result(response: anthropic.types.Message) -> LlmResult:
    text = "".join(block.text for block in response.content if block.type == "text")
    usage = response.usage
    return LlmResult(
        text=text,
        usage=Usage(
            input_tokens=usage.input_tokens or 0,
            output_tokens=usage.output_tokens or 0,
            cache_read_input_tokens=usage.cache_read_input_tokens or 0,
            cache_creation_input_tokens=usage.cache_creation_input_tokens or 0,
        ),
        stop_reason=response.stop_reason or "end_turn",
        model=response.model,
    )
