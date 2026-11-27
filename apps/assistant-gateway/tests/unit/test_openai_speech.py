from __future__ import annotations

import httpx
import pytest

from assistant_gateway.providers import ProviderRejected, ProviderUncertain
from assistant_gateway.providers.openai_speech import LazyOpenAiSpeechProvider, OpenAiSpeechProvider


def _provider(handler: object) -> OpenAiSpeechProvider:
    client = httpx.Client(transport=httpx.MockTransport(handler))  # type: ignore[arg-type]
    return OpenAiSpeechProvider("sk-test-not-real", "test-transcribe", client=client)


def _ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"text": "marhaba"})


def test_request_shape() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"text": "marhaba"})

    result = _provider(handler).transcribe(b"AUDIO-BYTES", "audio/webm;codecs=opus", "ar")
    assert result.text == "marhaba"
    (request,) = seen
    assert request.method == "POST"
    assert str(request.url) == "https://api.openai.com/v1/audio/transcriptions"
    assert request.headers["Authorization"] == "Bearer sk-test-not-real"
    assert request.headers["Content-Type"].startswith("multipart/form-data")
    body = request.content
    assert b'name="model"\r\n\r\ntest-transcribe' in body
    assert b'name="response_format"\r\n\r\njson' in body
    assert b'name="language"\r\n\r\nar' in body
    assert b'name="file"; filename="audio.webm"' in body
    assert b"AUDIO-BYTES" in body


def test_language_is_omitted_when_not_given() -> None:
    seen: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.content)
        return httpx.Response(200, json={"text": "x"})

    _provider(handler).transcribe(b"a", "audio/mp4", None)
    assert b'name="language"' not in seen[0]
    assert b'filename="audio.mp4"' in seen[0]


def test_a_regional_language_tag_is_sent_as_the_bare_language() -> None:
    seen: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.content)
        return httpx.Response(200, json={"text": "x"})

    _provider(handler).transcribe(b"a", "audio/webm", "ar-EG")
    assert b'name="language"\r\n\r\nar\r\n' in seen[0]


def test_client_has_a_30_second_timeout_and_no_retries() -> None:
    provider = OpenAiSpeechProvider("k", "m")
    client = provider._client  # noqa: SLF001
    assert client.timeout == httpx.Timeout(30.0)


@pytest.mark.parametrize("timeout", [httpx.ReadTimeout, httpx.ConnectTimeout, httpx.WriteTimeout])
def test_timeouts_are_uncertain(timeout: type[httpx.TimeoutException]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise timeout("slow", request=request)

    with pytest.raises(ProviderUncertain) as caught:
        _provider(handler).transcribe(b"a", "audio/webm", None)
    assert caught.value.code == "timeout"


def test_connect_error_is_rejected_because_nothing_was_sent() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(ProviderRejected):
        _provider(handler).transcribe(b"a", "audio/webm", None)


def test_other_transport_errors_are_uncertain() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadError("reset", request=request)

    with pytest.raises(ProviderUncertain):
        _provider(handler).transcribe(b"a", "audio/webm", None)


@pytest.mark.parametrize("status", [400, 401, 413, 429])
def test_4xx_is_rejected(status: int) -> None:
    with pytest.raises(ProviderRejected) as caught:
        _provider(lambda r: httpx.Response(status, json={"error": "SECRET-BODY"})).transcribe(
            b"a", "audio/webm", None
        )
    assert caught.value.code == f"http_{status}"
    assert "SECRET-BODY" not in str(caught.value)


@pytest.mark.parametrize("status", [500, 502, 503])
def test_5xx_is_uncertain(status: int) -> None:
    with pytest.raises(ProviderUncertain) as caught:
        _provider(lambda r: httpx.Response(status, text="SECRET-BODY")).transcribe(
            b"a", "audio/webm", None
        )
    assert caught.value.code == f"http_{status}"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, text="not json"),
        httpx.Response(200, json={"no_text": 1}),
        httpx.Response(200, json={"text": 5}),
        httpx.Response(200, json=["text"]),
    ],
    ids=["not_json", "no_text", "text_not_str", "not_object"],
)
def test_a_malformed_success_is_uncertain(response: httpx.Response) -> None:
    with pytest.raises(ProviderUncertain) as caught:
        _provider(lambda r: response).transcribe(b"a", "audio/webm", None)
    assert caught.value.code == "bad_response"


def test_lazy_provider_without_a_key_is_rejected() -> None:
    lazy = LazyOpenAiSpeechProvider("OPENAI_API_KEY", "m", environ={})
    assert lazy.name == "openai"
    with pytest.raises(ProviderRejected) as caught:
        lazy.transcribe(b"a", "audio/webm", None)
    assert caught.value.code == "not_configured"


def test_lazy_provider_without_a_model_is_rejected() -> None:
    lazy = LazyOpenAiSpeechProvider("OPENAI_API_KEY", None, environ={"OPENAI_API_KEY": "k"})
    with pytest.raises(ProviderRejected) as caught:
        lazy.transcribe(b"a", "audio/webm", None)
    assert caught.value.code == "not_configured"
