from __future__ import annotations

import json
import logging

import pytest

from connections_api.shared.logging import configure_logging

PHONE = "01012345678"
EMAIL = "a@b.co"


def _emitted(capsys: pytest.CaptureFixture[str]) -> str:
    out = capsys.readouterr().out
    assert out, "nothing was logged to stdout"
    return out


def test_log_redaction(capsys: pytest.CaptureFixture[str]) -> None:
    # configure_logging binds its handler to the current sys.stdout, so it must run inside the
    # test body, after capsys has swapped it in (not in a fixture).
    configure_logging("info")

    logging.getLogger("test").info("call %s or %s", PHONE, EMAIL)

    out = _emitted(capsys)
    assert "call" in out
    assert PHONE not in out
    assert EMAIL not in out


def test_log_redaction_covers_formatted_phone_numbers_and_extras(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging("info")

    logging.getLogger("test").info(
        "added +20 10 1234 5678 and 010-1234-5678", extra={"contact": EMAIL}
    )

    out = _emitted(capsys)
    assert "added" in out
    assert "1234" not in out
    assert EMAIL not in out


def test_log_redaction_covers_exception_text(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("info")

    try:
        raise ValueError(f"bad contact {EMAIL} / {PHONE}")
    except ValueError:
        logging.getLogger("test").exception("failed")

    out = _emitted(capsys)
    assert "failed" in out
    assert "ValueError" in out
    assert PHONE not in out
    assert EMAIL not in out


def test_log_redaction_masks_the_contributor_token_header(
    capsys: pytest.CaptureFixture[str],
) -> None:
    # No code path logs request headers today; if one ever does, the link token must not leak.
    token = "contributor-link-token-value"
    configure_logging("info")

    logging.getLogger("test").info(
        "request", extra={"headers": {"X-Contributor-Token": token, "Accept": "text/html"}}
    )

    out = _emitted(capsys)
    assert "text/html" in out
    assert token not in out


def test_log_redaction_keeps_ordinary_text(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("info")

    logging.getLogger("test").info("listed 42 people in 7 ms")

    assert json.loads(_emitted(capsys))["message"] == "listed 42 people in 7 ms"


def test_uvicorn_loggers_go_through_the_redacting_root_handler(
    capsys: pytest.CaptureFixture[str],
) -> None:
    uvicorn_access = logging.getLogger("uvicorn.access")
    uvicorn_access.addHandler(logging.StreamHandler())  # what uvicorn's own log config does

    configure_logging("info")
    uvicorn_access.info("GET /x for %s", EMAIL)

    out = _emitted(capsys)
    assert uvicorn_access.handlers == []
    assert "GET /x for" in out
    assert EMAIL not in out


@pytest.mark.parametrize(
    "number",
    [
        "010.1234.5678",
        "(010) 1234 5678",
        "010  1234  5678",
        "+20 (10) 1234-5678",
        "010 - 1234 - 5678",
        "٠١٠١٢٣٤٥٦٧٨",
    ],
)
def test_log_redaction_covers_other_phone_spellings(
    capsys: pytest.CaptureFixture[str], number: str
) -> None:
    configure_logging("info")

    logging.getLogger("test").info("call %s today", number)

    message = json.loads(_emitted(capsys))["message"]
    assert message.startswith("call ")
    assert message.endswith(" today")
    # Not one digit of the number is left (an area code alone already narrows it down).
    assert not any(ch.isdigit() for ch in message), message
