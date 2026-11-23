"""Every admin read endpoint reads from one snapshot.

A GET that runs several statements under READ COMMITTED sees a fresh snapshot per statement, so
a write committed between two of them can make the response inconsistent or crash it (a path
whose bridge was deleted between loading the graph and reading its names). Reads therefore use
`admin_snapshot_tx` (REPEATABLE READ). Writes stay on `admin_tx`. This test fails when a new
GET route depends on `admin_tx`.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any

from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute

from connections_api.deps import admin_snapshot_tx, admin_tx
from connections_api.main import create_app


def _calls(dependant: Dependant) -> Iterator[Callable[..., Any]]:
    for sub in dependant.dependencies:
        if sub.call is not None:
            yield sub.call
        yield from _calls(sub)


def test_admin_read_routes_use_one_snapshot() -> None:
    routes = [r for r in create_app().routes if isinstance(r, APIRoute)]
    reads = [r for r in routes if "GET" in r.methods]
    on_admin_tx = [r.path for r in reads if admin_tx in set(_calls(r.dependant))]

    assert on_admin_tx == []
    assert any(admin_snapshot_tx in set(_calls(r.dependant)) for r in reads)
