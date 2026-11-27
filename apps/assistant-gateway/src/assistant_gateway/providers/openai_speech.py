"""The OpenAI transcription adapter, over plain httpx.

No retries, for the same reason as the Claude adapter: a retry would hide whether the first
attempt was billed. Failures become the two errors the route understands, and the provider's
response body is never put in an error, so it cannot reach a log.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Mapping

import httpx

from assistant_gateway.providers import ProviderRejected, ProviderUncertain
from assistant_gateway.providers.speech import SpeechResult

URL = "https://api.openai.com/v1/audio/transcriptions"
TIMEOUT_SECONDS = 30.0

# OpenAI infers the container from the file name's extension.
_EXTENSIONS = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/x-m4a": "m4a",
    "audio/m4a": "m4a",
    "audio/aac": "m4a",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
}


class OpenAiSpeechProvider:
    name = "openai"

    def __init__(self, api_key: str, model: str, client: httpx.Client | None = None) -> None:
        self._api_key = api_key
        self._model = model
        # A plain client: no retry transport.
        self._client = client or httpx.Client(timeout=TIMEOUT_SECONDS)

    def transcribe(self, audio: bytes, mime: str, language: str | None) -> SpeechResult:
        data = {"model": self._model, "response_format": "json"}
        if language:
            data["language"] = language.split("-")[0].lower()  # ar-EG -> ar (ISO 639-1)
        extension = _EXTENSIONS.get(mime.split(";")[0].strip().lower(), "webm")
        try:
            response = self._client.post(
                URL,
                headers={"Authorization": f"Bearer {self._api_key}"},
                data=data,
                files={"file": (f"audio.{extension}", audio, mime)},
            )
        except httpx.TimeoutException:
            raise ProviderUncertain("timeout") from None
        except httpx.ConnectError:
            raise ProviderRejected("connection_error") from None  # nothing was sent
        except httpx.TransportError:
            raise ProviderUncertain("connection_error") from None
        if response.status_code >= 500:
            raise ProviderUncertain(f"http_{response.status_code}")
        if response.status_code >= 400:
            raise ProviderRejected(f"http_{response.status_code}")
        try:
            text = response.json()["text"]
        except (ValueError, KeyError, TypeError):
            raise ProviderUncertain("bad_response") from None
        if not isinstance(text, str):
            raise ProviderUncertain("bad_response")
        return SpeechResult(text=text)


class LazyOpenAiSpeechProvider:
    """Builds the real provider on first use, so an app boots without a key (tests, local dev).

    A missing key or model then fails the call as `ProviderRejected("not_configured")`: nothing
    was sent, so the route releases the reservation and answers 502 provider_unavailable.
    """

    name = "openai"

    def __init__(
        self, api_key_env: str, model: str | None, environ: Mapping[str, str] | None = None
    ) -> None:
        self._env_name = api_key_env
        self._model = model
        self._environ = os.environ if environ is None else environ
        self._provider: OpenAiSpeechProvider | None = None
        self._lock = threading.Lock()

    def transcribe(self, audio: bytes, mime: str, language: str | None) -> SpeechResult:
        return self._built().transcribe(audio, mime, language)

    def _built(self) -> OpenAiSpeechProvider:
        with self._lock:
            if self._provider is None:
                key = self._environ.get(self._env_name)
                if not key or not self._model:
                    raise ProviderRejected("not_configured")
                self._provider = OpenAiSpeechProvider(key, self._model)
            return self._provider
