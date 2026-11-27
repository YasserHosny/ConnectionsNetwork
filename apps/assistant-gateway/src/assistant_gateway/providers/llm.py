from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from assistant_gateway.pricing import Usage


@dataclass(frozen=True)
class LlmResult:
    text: str
    usage: Usage
    stop_reason: str
    model: str


class LlmProvider(Protocol):
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
        """Run one completion. Raises `ProviderRejected` or `ProviderUncertain` on failure."""
        ...
