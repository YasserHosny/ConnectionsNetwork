"""Weighted shortest paths over the connection graph.

Pure and DB-free: callers load the edges, `build_graph` them, then ask for paths.

Strength weights (global constraints): strong = 1, normal = 2, weak = 3.

Ordering of paths to the same node, everywhere in this module: lower cost, then fewer
hops, then the lexicographically smaller sequence of `str(uuid)`. That order is total over
simple paths and is preserved when a path is extended by one more node, which is what lets
Dijkstra (and Yen's spur searches) pick the same winner whatever order the edges came in.
"""

from __future__ import annotations

import heapq
from collections.abc import Collection, Iterable
from dataclasses import dataclass
from uuid import UUID

from connections_api.modules.people.schemas import Strength

Edge = tuple[UUID, UUID, Strength]
# Undirected adjacency map: node -> {neighbour: edge weight}.
Graph = dict[UUID, dict[UUID, int]]

WEIGHTS: dict[Strength, int] = {Strength.strong: 1, Strength.normal: 2, Strength.weak: 3}


@dataclass(frozen=True)
class PathResult:
    """`path` is a list of node ids from source to target, both included."""

    cost: int
    path: list[UUID]


# (cost, hops, str-sequence of the path, path): sorting these is the module's path order.
_Label = tuple[int, int, tuple[str, ...], tuple[UUID, ...]]


def build_graph(edges: Iterable[Edge]) -> Graph:
    """Undirected adjacency map. Self-loops are ignored; for repeated pairs the cheapest wins."""
    graph: Graph = {}
    for a, b, strength in edges:
        if a == b:
            continue
        weight = WEIGHTS[strength]
        for x, y in ((a, b), (b, a)):
            neighbours = graph.setdefault(x, {})
            if weight < neighbours.get(y, weight + 1):
                neighbours[y] = weight
    return graph


def _dijkstra(
    graph: Graph,
    source: UUID,
    *,
    target: UUID | None = None,
    banned_nodes: Collection[UUID] = (),
    banned_edges: Collection[tuple[UUID, UUID]] = (),
) -> dict[UUID, _Label]:
    """Best label per reachable node; stops early once `target` is settled."""
    best: dict[UUID, _Label] = {}
    heap: list[_Label] = [(0, 0, (str(source),), (source,))]
    while heap:
        label = heapq.heappop(heap)
        cost, hops, keys, path = label
        node = path[-1]
        if node in best:
            continue
        best[node] = label
        if node == target:
            break
        for neighbour, weight in graph.get(node, {}).items():
            if neighbour in best or neighbour in banned_nodes or (node, neighbour) in banned_edges:
                continue
            heapq.heappush(
                heap,
                (cost + weight, hops + 1, (*keys, str(neighbour)), (*path, neighbour)),
            )
    return best


def _result(label: _Label) -> PathResult:
    return PathResult(cost=label[0], path=list(label[3]))


def shortest_paths_from(graph: Graph, source: UUID) -> dict[UUID, PathResult]:
    """Cheapest path from `source` to every reachable node (the source itself costs 0).

    Unreachable nodes are absent from the result.
    """
    return {node: _result(label) for node, label in _dijkstra(graph, source).items()}


def k_shortest_paths(graph: Graph, source: UUID, target: UUID, k: int = 3) -> list[PathResult]:
    """Up to `k` distinct simple paths, best first (Yen's algorithm).

    Costs are non-decreasing and ties follow the module's path order. Returns `[]` when the
    target is unreachable, and the single zero-cost path when `source == target`.
    """
    if k < 1:
        return []
    if source == target:
        return [PathResult(cost=0, path=[source])]
    first = _dijkstra(graph, source, target=target).get(target)
    if first is None:
        return []

    accepted: list[_Label] = [first]
    candidates: list[_Label] = []
    queued: set[tuple[UUID, ...]] = {first[3]}
    while len(accepted) < k:
        previous = accepted[-1][3]
        for i in range(len(previous) - 1):
            spur = previous[i]
            root = previous[: i + 1]
            # Do not rediscover an accepted path sharing this root.
            banned_edges = {(spur, p[i + 1]) for _, _, _, p in accepted if p[: i + 1] == root}
            tail = _dijkstra(
                graph,
                spur,
                target=target,
                banned_nodes=root[:-1],
                banned_edges=banned_edges,
            ).get(target)
            if tail is None:
                continue
            full = (*root[:-1], *tail[3])
            if full in queued:
                continue
            queued.add(full)
            cost = _cost(graph, full)
            heapq.heappush(candidates, (cost, len(full) - 1, tuple(str(n) for n in full), full))
        if not candidates:
            break
        accepted.append(heapq.heappop(candidates))
    return [_result(label) for label in accepted]


def _cost(graph: Graph, path: tuple[UUID, ...]) -> int:
    return sum(graph[a][b] for a, b in zip(path, path[1:], strict=False))
