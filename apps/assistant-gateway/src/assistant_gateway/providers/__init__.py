"""Provider adapters (Claude here, speech in Task 8) and the errors they share.

An adapter reports a failed call as one of two errors, and the route's ledger handling depends
on which: a refused request can be released, an uncertain one may have been billed.
"""

from __future__ import annotations

__all__ = ["ProviderError", "ProviderRejected", "ProviderUncertain"]


class ProviderError(Exception):
    """A provider call failed. `code` is a short machine code; it never quotes request content."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ProviderRejected(ProviderError):
    """The provider refused the request before generating anything (4xx, 529).

    Nothing was billed, so the reservation is safe to release.
    """


class ProviderUncertain(ProviderError):
    """A timeout, a dropped connection or a 5xx: the call may have been billed.

    The reservation must keep counting.
    """
