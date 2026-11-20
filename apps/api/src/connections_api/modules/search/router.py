"""Search by skill, profession, industry or free text, ranked by closeness; alternative paths."""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, Query
from pydantic import StringConstraints

from connections_api.deps import AdminContext, admin_tx, current_admin
from connections_api.modules.people.schemas import (
    AvailableFor,
    Seniority,
    SkillCategory,
    SkillLevel,
)
from connections_api.modules.search import service
from connections_api.modules.search.schemas import AlternativePath, SearchResult

router = APIRouter(tags=["search"])

Admin = Annotated[AdminContext, Depends(current_admin)]
Tx = Annotated[psycopg.Connection[Any], Depends(admin_tx)]

# Free text and labels, capped like the fields they are matched against (people/schemas.py).
SearchText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
MAX_SKILL_FILTERS = 10


@router.get("/search", response_model=list[SearchResult])
def search(
    admin: Admin,
    conn: Tx,
    q: Annotated[SearchText | None, Query()] = None,
    skill: Annotated[list[SearchText] | None, Query(max_length=MAX_SKILL_FILTERS)] = None,
    category: SkillCategory | None = None,
    min_level: SkillLevel | None = None,
    industry: Annotated[SearchText | None, Query()] = None,
    seniority: Seniority | None = None,
    available_for: AvailableFor | None = None,
    city: Annotated[SearchText | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[SearchResult]:
    """Rank the network's people by path cost from the admin; 422 when no criterion is given.

    `skill` repeats: the person needs all of them. Unreachable people come last with
    `cost: null`. See modules/search/service.py for what each filter matches.
    """
    criteria = service.SearchCriteria(
        q=q,
        skills=tuple(skill or ()),
        category=category,
        min_level=min_level,
        industry=industry,
        seniority=seniority,
        available_for=available_for,
        city=city,
        limit=limit,
    )
    return service.search_people(conn, admin, criteria)


@router.get("/people/{person_id}/paths", response_model=list[AlternativePath])
def alternative_paths(
    person_id: UUID, admin: Admin, conn: Tx, k: Annotated[int, Query(ge=1, le=10)] = 3
) -> list[AlternativePath]:
    return service.alternative_paths(conn, admin, person_id, k)
