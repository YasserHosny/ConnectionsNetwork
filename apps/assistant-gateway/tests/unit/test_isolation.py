from __future__ import annotations

import ast
from pathlib import Path


def _imported_modules(tree: ast.AST) -> list[str]:
    modules: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            modules.append(node.module)
    return modules


def test_no_connections_api_imports() -> None:
    src = Path(__file__).parents[2] / "src"
    offenders = [
        path
        for path in src.rglob("*.py")
        if any(
            module == "connections_api" or module.startswith("connections_api.")
            for module in _imported_modules(ast.parse(path.read_text()))
        )
    ]
    assert offenders == []
