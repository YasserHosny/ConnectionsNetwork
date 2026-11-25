"""Request and response models for duplicate review and merge."""

from __future__ import annotations

from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, model_validator

from connections_api.modules.people.schemas import ContactInput, SocialLinkInput


class PersonSummary(BaseModel):
    person_id: UUID
    display_name: str
    profession: str | None
    city: str | None


class DuplicatePair(BaseModel):
    """Two people who share an identifying value, with every reason, a before b by id.

    `phone` covers phone and WhatsApp numbers alike (one normal form, so they match across the
    two kinds); `email` and `social_link` (a shared normalized URL) are the other reasons.
    """

    a: PersonSummary
    b: PersonSummary
    matched_on: list[Literal["email", "phone", "social_link"]]


class DismissRequest(BaseModel):
    a: UUID
    b: UUID

    @model_validator(mode="after")
    def _two_different_people(self) -> Self:
        if self.a == self.b:
            raise ValueError("a pair joins two different people")
        return self


class MergeRequest(BaseModel):
    keep: UUID
    drop: UUID

    @model_validator(mode="after")
    def _two_different_people(self) -> Self:
        if self.keep == self.drop:
            raise ValueError("keep and drop must be two different people")
        return self


class DuplicateCheckRequest(BaseModel):
    """The identifying values typed into a quick add, checked before the person is saved.

    A POST body, never a query string: contact values stay out of URLs and access logs. The lists
    take what a create takes (`PersonInput`), so no create skips the check for being too long.
    """

    contacts: list[ContactInput] = []
    social_links: list[SocialLinkInput] = []
