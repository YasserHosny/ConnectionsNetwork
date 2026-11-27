"""The gateway's YAML configuration: parsing, validation and secret resolution.

Secrets never appear in the file. It names environment variables (`key_hash_env`,
`api_key_env`), and this module reads only the key-hash ones. Provider API keys are checked
when a provider is built, so a config can be loaded in tests and local development without
real keys.

A `ConfigError` names the dotted YAML path of each fault and never contains a value read from
the environment.
"""

from __future__ import annotations

import hmac
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Any, Literal, Self
from zoneinfo import ZoneInfo

import yaml
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError, model_validator

from assistant_gateway.pricing import ModelPrice

PER_REQUEST = "per-request"

_KEY_HASH = re.compile(r"[0-9a-f]{64}")


class ConfigError(Exception):
    """The configuration is invalid. The message is safe to log: it holds paths, never secrets."""


def _to_decimal(value: object) -> object:
    # YAML reads 0.10 as a float. Going through str keeps the written digits, so binary
    # floating-point error never reaches money.
    if isinstance(value, bool):
        raise ValueError("must be a number")
    if isinstance(value, int | float):
        return Decimal(str(value))
    return value


def _to_zone(value: object) -> ZoneInfo:
    try:
        if not isinstance(value, str):
            raise TypeError
        return ZoneInfo(value)
    except (TypeError, ValueError, KeyError, OSError):
        raise ValueError("must be a known IANA timezone, e.g. Africa/Cairo") from None


type Money = Annotated[Decimal, BeforeValidator(_to_decimal), Field(ge=0, allow_inf_nan=False)]
# A price of zero would make a metered call free in the ledger, so prices are strictly positive.
type Price = Annotated[Decimal, BeforeValidator(_to_decimal), Field(gt=0, allow_inf_nan=False)]
type Fraction = Annotated[
    Decimal, BeforeValidator(_to_decimal), Field(ge=0, le=1, allow_inf_nan=False)
]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)


class _RawModelPrice(_Model):
    input: Price
    output: Price
    cache_write: Price
    cache_read: Price


class _RawSpeechPrice(_Model):
    per_minute: Price


class ProviderConfig(_Model):
    api_key_env: str = Field(min_length=1)
    model: str | None = None


class ProvidersConfig(_Model):
    anthropic: ProviderConfig
    openai: ProviderConfig | None = None
    elevenlabs: ProviderConfig | None = None

    def get(self, name: str) -> ProviderConfig | None:
        return {"openai": self.openai, "elevenlabs": self.elevenlabs}.get(name)


class BudgetConfig(_Model):
    monthly_cap_usd: Money
    per_user_daily_cap_usd: Money | None = None
    warn_at: Fraction


class SpeechConfig(_Model):
    mode: Literal["browser", "server"]
    provider: str | None = None
    language: str | None = None

    @model_validator(mode="after")
    def _server_needs_a_provider(self) -> Self:
        if self.mode == "server" and self.provider is None:
            raise ValueError(f"provider is required when mode is server (or {PER_REQUEST})")
        return self


class UseCaseConfig(_Model):
    model: str = Field(min_length=1)
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    max_output_tokens: int = Field(ge=1, le=64000)
    max_input_chars: int = Field(default=20000, ge=1)
    cap_usd: Money | None = None
    speech: SpeechConfig = SpeechConfig(mode="browser")
    max_audio_seconds: int = Field(default=60, ge=1, le=600)


class _RawApp(_Model):
    key_hash_env: str = Field(min_length=1)
    timezone: Annotated[ZoneInfo, BeforeValidator(_to_zone)]
    budget: BudgetConfig
    use_cases: dict[str, UseCaseConfig]


class _RawConfig(_Model):
    pricing: dict[str, _RawModelPrice]
    speech_pricing: dict[str, _RawSpeechPrice] = {}
    providers: ProvidersConfig
    apps: dict[str, _RawApp] = Field(min_length=1)


@dataclass(frozen=True)
class AppConfig:
    key_hash: str
    timezone: ZoneInfo
    budget: BudgetConfig
    use_cases: dict[str, UseCaseConfig]


@dataclass(frozen=True)
class GatewayConfig:
    pricing: dict[str, ModelPrice]
    speech_pricing: dict[str, Decimal]
    providers: ProvidersConfig
    apps: dict[str, AppConfig]

    def app_for_key_hash(self, h: str) -> tuple[str, AppConfig] | None:
        candidate = h.encode("utf-8")
        found: tuple[str, AppConfig] | None = None
        # No early exit: the time taken must not reveal which app's hash matched.
        for name, app in self.apps.items():
            if hmac.compare_digest(candidate, app.key_hash.encode("utf-8")):
                found = (name, app)
        return found


def load_config(path: Path, env: Mapping[str, str]) -> GatewayConfig:
    data = _read_yaml(path)
    raw = _parse(data)
    errors: list[str] = []
    apps = _resolve_apps(raw, env, errors)
    _check_references(raw, errors)
    if errors:
        raise ConfigError(_join(path, errors))
    return GatewayConfig(
        pricing={
            name: ModelPrice(p.input, p.output, p.cache_write, p.cache_read)
            for name, p in raw.pricing.items()
        },
        speech_pricing={name: p.per_minute for name, p in raw.speech_pricing.items()},
        providers=raw.providers,
        apps=apps,
    )


def _join(path: Path, errors: Sequence[str]) -> str:
    return f"Invalid configuration {path}:\n" + "\n".join(f"  {line}" for line in errors)


def _read_yaml(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"Cannot read configuration file {path}: {type(exc).__name__}") from None
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        where = f" (line {mark.line + 1})" if mark is not None else ""
        raise ConfigError(f"Configuration file {path} is not valid YAML{where}.") from None
    if not isinstance(data, dict):
        raise ConfigError(f"Configuration file {path} must be a YAML mapping at the top level.")
    return data


def _parse(data: dict[str, Any]) -> _RawConfig:
    shaped = dict(data)
    pricing = shaped.get("pricing")
    if isinstance(pricing, dict):
        # `pricing.speech` holds per-minute prices; every other key is a model.
        models = dict(pricing)
        shaped["speech_pricing"] = models.pop("speech", {})
        shaped["pricing"] = models
    try:
        return _RawConfig.model_validate(shaped)
    except ValidationError as exc:
        # Only `loc` and `msg`: pydantic's `input` would echo the offending value.
        lines = [
            f"{_dotted(e['loc'])}: {_clean(e['msg'])}"
            for e in exc.errors(include_input=False, include_url=False)
        ]
        raise ConfigError("Invalid configuration:\n" + "\n".join(f"  {x}" for x in lines)) from None


def _dotted(loc: Sequence[str | int]) -> str:
    parts = list(loc)
    if parts and parts[0] == "speech_pricing":
        parts[:1] = ["pricing", "speech"]
    out = ""
    for part in parts:
        if isinstance(part, int):
            out += f"[{part}]"
        else:
            out += f".{part}" if out else part
    return out or "<root>"


def _clean(msg: str) -> str:
    return msg.removeprefix("Value error, ")


def _resolve_apps(
    raw: _RawConfig, env: Mapping[str, str], errors: list[str]
) -> dict[str, AppConfig]:
    apps: dict[str, AppConfig] = {}
    owner_of_hash: dict[str, str] = {}
    for name, app in raw.apps.items():
        path = f"apps.{name}.key_hash_env"
        value = env.get(app.key_hash_env)
        if value is None:
            errors.append(f"{path}: environment variable {app.key_hash_env} is not set")
            continue
        if not _KEY_HASH.fullmatch(value):
            errors.append(
                f"{path}: environment variable {app.key_hash_env} must hold 64 lowercase "
                "hex characters"
            )
            continue
        if value in owner_of_hash:
            errors.append(f"{path}: same key hash as apps.{owner_of_hash[value]}")
            continue
        owner_of_hash[value] = name
        apps[name] = AppConfig(
            key_hash=value, timezone=app.timezone, budget=app.budget, use_cases=app.use_cases
        )
    return apps


def _check_references(raw: _RawConfig, errors: list[str]) -> None:
    for app_name, app in raw.apps.items():
        for case_name, case in app.use_cases.items():
            base = f"apps.{app_name}.use_cases.{case_name}"
            if case.model != PER_REQUEST and case.model not in raw.pricing:
                errors.append(f"{base}.model: model has no entry in pricing")
            speech = case.speech
            if speech.mode != "server" or speech.provider in (None, PER_REQUEST):
                continue
            provider = speech.provider or ""
            if provider not in raw.speech_pricing:
                errors.append(f"{base}.speech.provider: no entry in pricing.speech")
            elif raw.providers.get(provider) is None:
                errors.append(f"{base}.speech.provider: not configured under providers")
