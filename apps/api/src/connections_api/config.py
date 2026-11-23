from functools import lru_cache
from typing import Annotated, Any, Literal

from pydantic import Field, SecretStr, ValidationError, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

type ApiEnvironment = Literal["local", "staging", "production"]


class Settings(BaseSettings):
    # The validation input is the whole raw environment mapping, so it carries every
    # secret. Keep it out of error strings, and strip it from the error data itself.
    model_config = SettingsConfigDict(
        case_sensitive=False, extra="ignore", hide_input_in_errors=True
    )

    def __init__(self, **values: object) -> None:
        try:
            super().__init__(**values)
        except ValidationError as exc:
            raise _without_inputs(exc) from None

    api_env: ApiEnvironment = Field(validation_alias="API_ENV")
    api_cors_origins: Annotated[tuple[str, ...], NoDecode] = Field(
        validation_alias="API_CORS_ORIGINS"
    )

    supabase_url: str = Field(validation_alias="SUPABASE_URL")
    supabase_anon_key: SecretStr = Field(validation_alias="SUPABASE_ANON_KEY")
    supabase_jwt_audience: str = Field(validation_alias="SUPABASE_JWT_AUDIENCE")
    supabase_jwt_issuer: str = Field(validation_alias="SUPABASE_JWT_ISSUER")
    # Optional: only the HS256 verification path (local/test) reads it. Hosted Supabase signs
    # with asymmetric keys resolved from JWKS, so an unset secret makes every HS256 token refused.
    supabase_jwt_secret: SecretStr | None = Field(
        default=None, validation_alias="SUPABASE_JWT_SECRET"
    )

    database_url: SecretStr = Field(validation_alias="DATABASE_URL")

    web_public_url: str = Field(validation_alias="WEB_PUBLIC_URL")

    @field_validator("api_cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: object) -> tuple[str, ...] | object:
        if isinstance(value, str):
            origins = tuple(origin.strip() for origin in value.split(",") if origin.strip())
            if not origins:
                raise ValueError("API_CORS_ORIGINS must contain at least one origin")
            return origins
        return value


def _without_inputs(exc: ValidationError) -> ValidationError:
    line_errors: list[Any] = []
    for error in exc.errors(include_url=False, include_input=False):
        line_error: dict[str, Any] = {"type": error["type"], "loc": error["loc"], "input": None}
        if "ctx" in error:
            line_error["ctx"] = error["ctx"]
        line_errors.append(line_error)
    return ValidationError.from_exception_data(exc.title, line_errors, hide_input=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
