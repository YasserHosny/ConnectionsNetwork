"""Response models for search and alternative paths (the filters are query parameters)."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from connections_api.modules.people.schemas import AvailableFor, SkillLevel


class PathNode(BaseModel):
    person_id: UUID
    display_name: str


class MatchedSkill(BaseModel):
    label: str
    level: SkillLevel | None


class SearchResult(BaseModel):
    person_id: UUID
    display_name: str
    profession: str | None
    headline: str | None
    city: str | None
    matched_skills: list[MatchedSkill]
    available_for: list[AvailableFor]
    last_confirmed_at: datetime
    is_stale: bool
    # Owner first, target last; empty when the person cannot be reached from the owner.
    path: list[PathNode]
    # Total path weight (strong 1, normal 2, weak 3); null when unreachable.
    cost: int | None
    # Hops on the path (people on it minus one); 0 when unreachable.
    steps: int


class AlternativePath(BaseModel):
    cost: int
    path: list[PathNode]
