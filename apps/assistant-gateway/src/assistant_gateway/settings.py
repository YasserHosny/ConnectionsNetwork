from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

type GatewayEnvironment = Literal["local", "staging", "production"]


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

    ag_env: GatewayEnvironment = Field(validation_alias="AG_ENV")
    ag_config_path: Path = Field(validation_alias="AG_CONFIG_PATH")
    ag_database_url: SecretStr = Field(validation_alias="AG_DATABASE_URL")


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
