from __future__ import annotations

import pytest
from pydantic import ValidationError

from connections_api.config import Settings

REQUIRED = (
    "API_ENV",
    "API_CORS_ORIGINS",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_JWT_AUDIENCE",
    "SUPABASE_JWT_ISSUER",
    "DATABASE_URL",
    "WEB_PUBLIC_URL",
)


def test_settings_load_from_environment() -> None:
    settings = Settings()

    assert settings.api_env == "local"
    assert settings.api_cors_origins == ("http://localhost:4200",)
    assert settings.web_public_url == "http://localhost:4200"


def test_cors_origins_split_on_commas(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_CORS_ORIGINS", "http://a.test, http://b.test ,")

    assert Settings().api_cors_origins == ("http://a.test", "http://b.test")


@pytest.mark.parametrize("name", REQUIRED)
def test_every_required_variable_is_required(name: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(name)

    with pytest.raises(ValidationError):
        Settings()


def test_validation_errors_never_echo_secret_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_ENV", "not-an-environment")

    with pytest.raises(ValidationError) as excinfo:
        Settings()

    assert "fake-anon-key-for-tests-only" not in str(excinfo.value)
    assert "postgres:postgres" not in str(excinfo.value)


def test_jwt_secret_is_optional(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SUPABASE_JWT_SECRET")

    assert Settings().supabase_jwt_secret is None


def test_jwt_secret_is_a_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings()

    assert settings.supabase_jwt_secret is not None
    assert "test-secret-value" not in repr(settings)
