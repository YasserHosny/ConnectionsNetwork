"""Request and response models for the people, connections and tags endpoints.

The enums are the value sets of the global constraints and of the database enums
(20261119000002_core_schema.sql); a value outside them is a 422 before it reaches Postgres.
"""

from __future__ import annotations

import re
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    StringConstraints,
    field_validator,
    model_validator,
)


class Strength(StrEnum):
    strong = "strong"
    normal = "normal"
    weak = "weak"


class SkillLevel(StrEnum):
    basic = "basic"
    good = "good"
    expert = "expert"


class SkillCategory(StrEnum):
    technical = "technical"
    languages = "languages"
    sports = "sports"
    arts_literature = "arts_literature"
    culture = "culture"
    crafts_trades = "crafts_trades"
    business = "business"
    other = "other"


class Seniority(StrEnum):
    employee = "employee"
    manager = "manager"
    decision_maker = "decision_maker"
    business_owner = "business_owner"


class AvailableFor(StrEnum):
    job_seeking = "job_seeking"
    freelance = "freelance"
    offers_service = "offers_service"
    partner_seeking = "partner_seeking"


class SocialLinkKind(StrEnum):
    facebook = "facebook"
    x = "x"
    linkedin = "linkedin"
    instagram = "instagram"
    github = "github"
    website = "website"


class ContactKind(StrEnum):
    phone = "phone"
    whatsapp = "whatsapp"
    email = "email"


class TagKind(StrEnum):
    skill = "skill"
    industry = "industry"


# Surrounding whitespace is dropped on the way in; limits keep a single field from being abused.
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)]
Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
# A social link is opened by the admin's browser, so it must be a web address: http(s) with a
# host, or a bare host and path ("linkedin.com/in/x"), which is stored with https:// in front.
# Every other scheme (javascript:, data:, mailto:, ftp:, scheme-relative //...) is refused. The
# same rule is enforced again by the SQL function contribute_person.
_HTTP_URL = re.compile(r"^https?://[^\s/?#]+", re.IGNORECASE)
_BARE_URL = re.compile(r"^[^\s:/?#]+(?::[0-9]+)?(?:[/?#].*)?$")


def _web_url(value: str) -> str:
    if _HTTP_URL.match(value):
        return value
    if "://" not in value and _BARE_URL.match(value):
        return f"https://{value}"
    raise ValueError("a link must be a web address (http or https)")


Url = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=500),
    AfterValidator(_web_url),
]
ContactValue = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]


class SkillInput(BaseModel):
    label: Label
    category: SkillCategory
    level: SkillLevel | None = None


class SocialLinkInput(BaseModel):
    kind: SocialLinkKind
    url: Url


class ContactInput(BaseModel):
    kind: ContactKind
    value: ContactValue


class PersonInput(BaseModel):
    name_ar: ShortText | None = None
    name_latin: ShortText | None = None
    headline: ShortText | None = None
    organization: ShortText | None = None
    profession: ShortText | None = None
    seniority: Seniority | None = None
    available_for: list[AvailableFor] = []
    city: ShortText | None = None
    country: ShortText | None = None
    admin_notes: LongText | None = None
    skills: list[SkillInput] = []
    industries: list[Label] = []
    social_links: list[SocialLinkInput] = []
    contacts: list[ContactInput] = []

    @field_validator(
        "name_ar",
        "name_latin",
        "headline",
        "organization",
        "profession",
        "city",
        "country",
        "admin_notes",
    )
    @classmethod
    def _blank_text_is_absent(cls, value: str | None) -> str | None:
        return value or None

    @model_validator(mode="after")
    def _a_name_is_required(self) -> Self:
        if self.name_ar is None and self.name_latin is None:
            raise ValueError("name_ar or name_latin is required")
        return self


class NewPersonRequest(BaseModel):
    person: PersonInput
    # The admin by default in the UI (spec 8.3); any person in the network otherwise.
    connect_to_person_id: UUID
    strength: Strength
    connection_note: LongText | None = None


class ConnectionIn(BaseModel):
    person_a: UUID
    person_b: UUID
    strength: Strength
    note: LongText | None = None

    @model_validator(mode="after")
    def _two_different_people(self) -> Self:
        if self.person_a == self.person_b:
            raise ValueError("a connection joins two different people")
        return self


class ConnectionPatch(BaseModel):
    """Fields left out stay as they are; `note: null` clears the note."""

    strength: Strength | None = None
    note: LongText | None = None

    @model_validator(mode="after")
    def _strength_is_never_null(self) -> Self:
        if "strength" in self.model_fields_set and self.strength is None:
            raise ValueError("strength cannot be null")
        return self


class ConnectionRecord(BaseModel):
    id: UUID
    person_a: UUID
    person_b: UUID
    strength: Strength
    note: str | None
    created_by_person_id: UUID | None
    created_at: datetime


class ConnectionOut(BaseModel):
    """A connection as seen from one person: who is at the other end."""

    id: UUID
    person_id: UUID
    display_name: str
    strength: Strength
    note: str | None


class SkillOut(BaseModel):
    tag_id: UUID
    label: str
    category: SkillCategory
    level: SkillLevel | None


class IndustryOut(BaseModel):
    tag_id: UUID
    label: str


class SocialLinkOut(BaseModel):
    id: UUID
    kind: SocialLinkKind
    url: str


class ContactOut(BaseModel):
    id: UUID
    kind: ContactKind
    value: str
    added_by_person_id: UUID | None


class PersonOut(BaseModel):
    id: UUID
    name_ar: str | None
    name_latin: str | None
    display_name: str
    headline: str | None
    organization: str | None
    profession: str | None
    seniority: Seniority | None
    available_for: list[AvailableFor]
    city: str | None
    country: str | None
    admin_notes: str | None
    photo_path: str | None
    last_confirmed_at: datetime
    is_stale: bool
    created_by_person_id: UUID | None
    created_via: Literal["admin", "link"]
    contributor_link_id: UUID | None
    created_at: datetime
    skills: list[SkillOut]
    industries: list[IndustryOut]
    social_links: list[SocialLinkOut]
    contacts: list[ContactOut]
    connections: list[ConnectionOut]


class DuplicateHint(BaseModel):
    person_id: UUID
    display_name: str
    matched_on: Literal["phone", "whatsapp", "email", "social_link"]


class CreatePersonResponse(BaseModel):
    person: PersonOut
    possible_duplicates: list[DuplicateHint]


class TagOut(BaseModel):
    id: UUID
    label: str
    category: SkillCategory | None
