"""Load the connection graph of the admin's network from the database."""

from __future__ import annotations

from typing import Any

import psycopg

from connections_api.modules.graph.paths import Graph, build_graph
from connections_api.modules.people.schemas import Strength


def load_graph(conn: psycopg.Connection[Any]) -> Graph:
    """Every connection of the admin's network (row-level security), once per request."""
    rows = conn.execute("select person_a, person_b, strength from connection").fetchall()
    return build_graph((a, b, Strength(strength)) for a, b, strength in rows)
