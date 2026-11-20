from __future__ import annotations

import itertools
import random
from uuid import UUID

import pytest

from connections_api.modules.graph.paths import (
    WEIGHTS,
    Edge,
    PathResult,
    build_graph,
    k_shortest_paths,
    shortest_paths_from,
)
from connections_api.modules.people.schemas import Strength

S, N, W = Strength.strong, Strength.normal, Strength.weak


def u(n: int) -> UUID:
    return UUID(int=n)


def test_weights_are_strong_1_normal_2_weak_3() -> None:
    assert WEIGHTS == {S: 1, N: 2, W: 3}


def test_source_cost_zero() -> None:
    graph = build_graph([(u(1), u(2), S)])
    result = shortest_paths_from(graph, u(1))
    assert result[u(1)] == PathResult(cost=0, path=[u(1)])


def test_source_not_in_graph_still_has_cost_zero() -> None:
    result = shortest_paths_from(build_graph([]), u(1))
    assert result == {u(1): PathResult(cost=0, path=[u(1)])}


def test_strong_longer_beats_weak_shorter() -> None:
    owner, a, b, c, t = u(1), u(2), u(3), u(4), u(5)
    graph = build_graph(
        [
            (owner, a, W),
            (a, t, W),  # cost 6
            (owner, b, S),
            (b, c, S),
            (c, t, S),  # cost 3
        ]
    )
    result = shortest_paths_from(graph, owner)
    assert result[t].cost == 3
    assert result[t].path == [owner, b, c, t]


def test_cycle_terminates() -> None:
    a, b, c, tail = u(1), u(2), u(3), u(4)
    graph = build_graph([(a, b, S), (b, c, N), (c, a, W), (c, tail, S)])
    result = shortest_paths_from(graph, a)
    assert {node: r.cost for node, r in result.items()} == {a: 0, b: 1, c: 3, tail: 4}
    # c costs 3 both directly (weak) and via b (strong + normal): the direct edge has fewer hops.
    assert result[c].path == [a, c]
    assert result[tail].path == [a, c, tail]


def test_cycle_costs_and_paths_exact() -> None:
    a, b, c, tail = u(1), u(2), u(3), u(4)
    # a-b strong(1), b-c strong(1), c-a weak(3): c is cheaper via b.
    graph = build_graph([(a, b, S), (b, c, S), (c, a, W), (c, tail, N)])
    result = shortest_paths_from(graph, a)
    assert {node: r.cost for node, r in result.items()} == {a: 0, b: 1, c: 2, tail: 4}
    assert result[tail].path == [a, b, c, tail]


def test_unreachable_absent() -> None:
    a, b, lonely = u(1), u(2), u(3)
    other_x, other_y = u(4), u(5)
    graph = build_graph([(a, b, N), (other_x, other_y, S)])
    result = shortest_paths_from(graph, a)
    assert set(result) == {a, b}
    assert lonely not in result and other_x not in result


def test_fewer_hops_beats_lexicographic_on_equal_cost() -> None:
    # direct weak (3) vs strong+strong+strong chain (3): direct has fewer hops.
    s, a, b, t = u(1), u(2), u(3), u(9)
    graph = build_graph([(s, t, W), (s, a, S), (a, b, S), (b, t, S)])
    assert shortest_paths_from(graph, s)[t].path == [s, t]


def test_lexicographic_tie_break_uses_uuid_strings() -> None:
    s, t = u(1), u(100)
    low, high = u(5), u(7)
    graph = build_graph([(s, high, S), (high, t, S), (s, low, S), (low, t, S)])
    assert shortest_paths_from(graph, s)[t].path == [s, low, t]


def test_lexicographic_tie_break_is_by_string_not_int() -> None:
    # str(UUID(int=0xA)) sorts after str(UUID(int=0x1_0000_0000...)): compare as strings.
    s, t = u(1), u(2)
    big = UUID("00000000-0000-0000-0000-00000000000a")
    small = UUID("00000000-0000-0000-0000-000000000009")
    graph = build_graph([(s, big, S), (big, t, S), (s, small, S), (small, t, S)])
    assert shortest_paths_from(graph, s)[t].path == [s, small, t]


def test_equal_cost_deterministic_with_shuffled_edges() -> None:
    s, a, b, c, t = u(1), u(2), u(3), u(4), u(5)
    edges: list[Edge] = [
        (s, a, N),
        (a, t, N),
        (s, b, N),
        (b, t, N),
        (s, c, S),
        (c, a, S),
        (c, b, S),
    ]
    rng = random.Random(7)
    seen = set()
    for _ in range(20):
        rng.shuffle(edges)
        flipped = [(y, x, st) if rng.random() < 0.5 else (x, y, st) for x, y, st in edges]
        result = shortest_paths_from(build_graph(flipped), s)
        seen.add(tuple(tuple(r.path) for _, r in sorted(result.items())))
    assert len(seen) == 1


def test_build_graph_keeps_cheapest_duplicate_and_ignores_self_loops() -> None:
    a, b = u(1), u(2)
    graph = build_graph([(a, b, W), (b, a, S), (a, b, N), (a, a, S)])
    result = shortest_paths_from(graph, a)
    assert result[b].cost == 1
    assert set(result) == {a, b}


def _all_simple_paths(
    edges: list[Edge], source: UUID, target: UUID
) -> list[tuple[int, int, tuple[str, ...], list[UUID]]]:
    weights: dict[frozenset[UUID], int] = {}
    for x, y, st in edges:
        if x == y:
            continue
        key = frozenset((x, y))
        weights[key] = min(weights.get(key, 99), WEIGHTS[st])
    adjacency: dict[UUID, list[UUID]] = {}
    for key in weights:
        x, y = tuple(key)
        adjacency.setdefault(x, []).append(y)
        adjacency.setdefault(y, []).append(x)
    found: list[tuple[int, int, tuple[str, ...], list[UUID]]] = []

    def walk(path: list[UUID], cost: int) -> None:
        node = path[-1]
        if node == target:
            found.append((cost, len(path) - 1, tuple(str(p) for p in path), list(path)))
            return
        for nxt in adjacency.get(node, []):
            if nxt not in path:
                walk([*path, nxt], cost + weights[frozenset((node, nxt))])

    walk([source], 0)
    found.sort(key=lambda f: f[:3])
    return found


def _random_edges(rng: random.Random, nodes: int, density: float) -> list[Edge]:
    ids = [u(rng.randrange(1, 10**6)) for _ in range(nodes)]
    ids = list(dict.fromkeys(ids))
    return [
        (x, y, rng.choice([S, N, W]))
        for x, y in itertools.combinations(ids, 2)
        if rng.random() < density
    ]


@pytest.mark.parametrize("seed", range(40))
def test_matches_brute_force_on_random_graphs(seed: int) -> None:
    rng = random.Random(seed)
    edges = _random_edges(rng, nodes=rng.randint(2, 8), density=rng.choice([0.3, 0.5, 0.8]))
    nodes = sorted({n for e in edges for n in e[:2]})
    if not nodes:
        return
    source = rng.choice(nodes)
    graph = build_graph(edges)
    result = shortest_paths_from(graph, source)
    for target in nodes:
        expected = _all_simple_paths(edges, source, target)
        if not expected:
            assert target not in result
            continue
        assert (result[target].cost, result[target].path) == (expected[0][0], expected[0][3])
        top = k_shortest_paths(graph, source, target, k=5)
        assert [(p.cost, p.path) for p in top] == [(c, p) for c, _, _, p in expected[:5]]


def test_k_shortest_returns_distinct_ordered() -> None:
    s, a, b, c, t = u(1), u(2), u(3), u(4), u(5)
    graph = build_graph(
        [
            (s, a, S),
            (a, t, S),  # cost 2
            (s, b, N),
            (b, t, N),  # cost 4
            (s, c, W),
            (c, t, W),  # cost 6
            (a, b, W),  # adds longer simple paths too
        ]
    )
    paths = k_shortest_paths(graph, s, t, k=3)
    assert len(paths) == 3
    assert [p.cost for p in paths] == sorted(p.cost for p in paths)
    assert len({tuple(p.path) for p in paths}) == 3
    assert paths[0] == PathResult(cost=2, path=[s, a, t])
    for p in paths:
        assert len(set(p.path)) == len(p.path)  # simple
        assert p.path[0] == s and p.path[-1] == t


def test_k_shortest_default_k_is_three() -> None:
    s, t = u(1), u(2)
    mids = [u(10 + i) for i in range(5)]
    graph = build_graph([e for m in mids for e in ((s, m, S), (m, t, S))])
    assert len(k_shortest_paths(graph, s, t)) == 3


def test_k_shortest_fewer_than_k_available() -> None:
    s, a, t = u(1), u(2), u(3)
    graph = build_graph([(s, a, S), (a, t, S)])
    assert k_shortest_paths(graph, s, t, k=5) == [PathResult(cost=2, path=[s, a, t])]


def test_k_shortest_source_equals_target() -> None:
    s = u(1)
    graph = build_graph([(s, u(2), S)])
    assert k_shortest_paths(graph, s, s, k=3) == [PathResult(cost=0, path=[s])]


def test_k_shortest_unreachable_is_empty() -> None:
    graph = build_graph([(u(1), u(2), S), (u(3), u(4), S)])
    assert k_shortest_paths(graph, u(1), u(4), k=3) == []
    assert k_shortest_paths(graph, u(1), u(99), k=3) == []


def test_k_shortest_non_positive_k_is_empty() -> None:
    graph = build_graph([(u(1), u(2), S)])
    assert k_shortest_paths(graph, u(1), u(2), k=0) == []


def test_k_shortest_cycle_paths_stay_simple() -> None:
    a, b, c, t = u(1), u(2), u(3), u(4)
    graph = build_graph([(a, b, S), (b, c, S), (c, a, S), (c, t, S), (b, t, N)])
    paths = k_shortest_paths(graph, a, t, k=10)
    assert paths  # terminates with every simple path, no repeats
    assert all(len(set(p.path)) == len(p.path) for p in paths)
    assert len({tuple(p.path) for p in paths}) == len(paths)
