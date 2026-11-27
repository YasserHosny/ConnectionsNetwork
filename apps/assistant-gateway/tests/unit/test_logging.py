"""An exception reaches the log as its class name only: never its message or a traceback."""

from __future__ import annotations

import json
import logging
import sys

import pytest

from assistant_gateway.logging import JsonFormatter, configure_logging

MARKER = "MARKER-9c2e"


class _Boom(Exception):
    pass


def _raise() -> None:
    raise _Boom(f"prompt text {MARKER}")


def test_json_formatter_emits_the_exception_class_only() -> None:
    try:
        _raise()
    except _Boom:
        record = logging.LogRecord("x", logging.ERROR, __file__, 1, "failed", None, sys.exc_info())
    line = JsonFormatter().format(record)
    assert MARKER not in line
    assert "Traceback" not in line
    assert json.loads(line)["exc_type"] == "_Boom"
    assert "exception" not in json.loads(line)


def test_every_logger_is_covered_through_configure_logging(
    capfd: pytest.CaptureFixture[str],
) -> None:
    configure_logging("info")
    # What uvicorn does for an exception that escapes the app.
    logger = logging.getLogger("uvicorn.error")
    try:
        _raise()
    except _Boom:
        logger.error("Exception in ASGI application", exc_info=True)
    out = capfd.readouterr().out
    assert MARKER not in out
    assert "Traceback" not in out
    assert json.loads(out.strip().splitlines()[-1])["exc_type"] == "_Boom"
