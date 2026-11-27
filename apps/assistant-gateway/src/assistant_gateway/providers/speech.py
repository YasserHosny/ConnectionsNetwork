from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class SpeechResult:
    text: str


class SpeechProvider(Protocol):
    name: str

    def transcribe(self, audio: bytes, mime: str, language: str | None) -> SpeechResult:
        """Transcribe one recording. Raises `ProviderRejected` or `ProviderUncertain`."""
        ...
