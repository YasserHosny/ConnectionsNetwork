"""Request and response models for contributor links (admin) and the contributor endpoints.

A contributor submits the admin's PersonInput minus `admin_notes`, with bounded lists. The same
rules are enforced again by the SQL function `contribute_person`
(20261119000008_contributor_link_functions.sql), which does not trust the API; keep the limits
here in step with the ones there.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from connections_api.modules.people.schemas import (
    AvailableFor,
    ContactInput,
    Label,
    PersonInput,
    SkillCategory,
    SkillInput,
    SocialLinkInput,
    Strength,
)

MAX_AVAILABLE_FOR = 4
MAX_SKILLS = 50
MAX_INDUSTRIES = 20
MAX_SOCIAL_LINKS = 20
MAX_CONTACTS = 20

# -- admin --------------------------------------------------------------------------------------


class CreateLinkRequest(BaseModel):
    person_id: UUID


class IssuedLink(BaseModel):
    """A link with its token. The URL is shown once: only the token's sha256 is stored."""

    link_id: UUID
    url: str
    expires_at: datetime


class LinkOut(BaseModel):
    link_id: UUID
    person_id: UUID
    display_name: str
    expires_at: datetime
    revoked_at: datetime | None
    people_added: int


# -- contributor --------------------------------------------------------------------------------


class ContributorPersonInput(PersonInput):
    """PersonInput as a contributor may send it: no admin notes, no unknown keys, bounded lists."""

    model_config = ConfigDict(extra="forbid")

    available_for: list[AvailableFor] = Field(default=[], max_length=MAX_AVAILABLE_FOR)
    skills: list[SkillInput] = Field(default=[], max_length=MAX_SKILLS)
    industries: list[Label] = Field(default=[], max_length=MAX_INDUSTRIES)
    social_links: list[SocialLinkInput] = Field(default=[], max_length=MAX_SOCIAL_LINKS)
    contacts: list[ContactInput] = Field(default=[], max_length=MAX_CONTACTS)

    @model_validator(mode="before")
    @classmethod
    def _no_admin_notes(cls, data: Any) -> Any:  # noqa: ANN401 - pydantic's raw input
        if isinstance(data, dict) and "admin_notes" in data:
            raise ValueError("admin_notes is not accepted from a contributor")
        return data

    def payload(self) -> dict[str, Any]:
        """The person object `contribute_person` takes: every field except admin_notes."""
        return self.model_dump(mode="json", exclude={"admin_notes"})


class ContributeRequest(BaseModel):
    """The new person and how well the contributor knows them; they connect to the contributor."""

    model_config = ConfigDict(extra="forbid")

    person: ContributorPersonInput
    strength: Strength


class ContributeResponse(BaseModel):
    person_id: UUID


class ContributorInfo(BaseModel):
    contributor_display_name: str
    expires_at: datetime


class ContributorTag(BaseModel):
    label: str
    category: SkillCategory | None
