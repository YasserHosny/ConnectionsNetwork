"""Test doubles for the provider boundary. Nothing here touches the network."""

from __future__ import annotations

from assistant_gateway.providers.llm import LlmResult
from assistant_gateway.providers.speech import SpeechResult


class FakeLlm:
    """An `LlmProvider` that returns `outcome`, or raises it when it is an exception.

    Every call's keyword arguments are recorded in `calls`.
    """

    def __init__(self, outcome: LlmResult | Exception) -> None:
        self.outcome = outcome
        self.calls: list[dict[str, object]] = []

    def complete(self, **kwargs: object) -> LlmResult:
        self.calls.append(kwargs)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


class FakeSpeech:
    """A `SpeechProvider` that returns `outcome`, or raises it when it is an exception.

    Every call is recorded in `calls` as (audio, mime, language).
    """

    def __init__(self, outcome: SpeechResult | Exception, name: str = "openai") -> None:
        self.name = name
        self.outcome = outcome
        self.calls: list[tuple[bytes, str, str | None]] = []

    def transcribe(self, audio: bytes, mime: str, language: str | None) -> SpeechResult:
        self.calls.append((audio, mime, language))
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome
