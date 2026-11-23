"""Response model for the review lists."""

from __future__ import annotations

from datetime import datetime

from connections_api.modules.duplicates.schemas import PersonSummary


class ReviewPerson(PersonSummary):
    """A person on a review list, with when their profile was last confirmed."""

    last_confirmed_at: datetime
