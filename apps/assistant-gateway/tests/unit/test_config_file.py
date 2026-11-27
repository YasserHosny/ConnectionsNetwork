from __future__ import annotations

import copy
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
import yaml

from assistant_gateway.config import ConfigError, load_config
from assistant_gateway.pricing import ModelPrice

CONFIG_DIR = Path(__file__).resolve().parents[2] / "config"

HASH_A = "a" * 64
HASH_B = "b" * 64

ENV: dict[str, str] = {"AG_CONNECTIONS_KEY_HASH": HASH_A, "AG_TRIAL_KEY_HASH": HASH_B}

FAKE_ENV: dict[str, str] = {
    "AG_CONNECTIONS_KEY_HASH": "0123456789abcdef" * 4,
    "AG_TRIAL_KEY_HASH": "fedcba9876543210" * 4,
}

BASE: dict[str, Any] = {
    "pricing": {
        "claude-haiku-4-5": {
            "input": 1.00,
            "output": 5.00,
            "cache_write": 1.25,
            "cache_read": 0.10,
        },
        "claude-sonnet-5-5": {
            "input": 2.00,
            "output": 10.00,
            "cache_write": 2.50,
            "cache_read": 0.20,
        },
        "claude-opus-5-5": {
            "input": 4.00,
            "output": 20.00,
            "cache_write": 5.00,
            "cache_read": 0.20,
        },
        "speech": {"openai": {"per_minute": 0.006}, "elevenlabs": {"per_minute": 0.006}},
    },
    "providers": {
        "anthropic": {"api_key_env": "ANTHROPIC_API_KEY"},
        "openai": {"api_key_env": "OPENAI_API_KEY", "model": "gpt-4o-transcribe"},
    },
    "apps": {
        "connections": {
            "key_hash_env": "AG_CONNECTIONS_KEY_HASH",
            "timezone": "Africa/Cairo",
            "budget": {"monthly_cap_usd": 5.00, "per_user_daily_cap_usd": 1.00, "warn_at": 0.8},
            "use_cases": {
                "person_add": {
                    "model": "claude-haiku-4-5",
                    "effort": "low",
                    "max_output_tokens": 2000,
                    "max_input_chars": 20000,
                    "speech": {"mode": "browser", "language": "ar-EG"},
                }
            },
        }
    },
}


def write(tmp_path: Path, mutate: Callable[[dict[str, Any]], None] | None = None) -> Path:
    data = copy.deepcopy(BASE)
    if mutate is not None:
        mutate(data)
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    return path


def use_case(data: dict[str, Any]) -> dict[str, Any]:
    return data["apps"]["connections"]["use_cases"]["person_add"]


def test_valid_file_loads(tmp_path: Path) -> None:
    cfg = load_config(write(tmp_path), ENV)

    app = cfg.apps["connections"]
    assert app.budget.monthly_cap_usd == Decimal("5.00")
    assert app.budget.per_user_daily_cap_usd == Decimal("1.00")
    assert app.budget.warn_at == Decimal("0.8")
    assert app.timezone == ZoneInfo("Africa/Cairo")
    assert app.key_hash == HASH_A
    case = app.use_cases["person_add"]
    assert (case.model, case.effort, case.max_output_tokens) == ("claude-haiku-4-5", "low", 2000)
    assert case.max_audio_seconds == 60
    assert case.cap_usd is None
    assert case.speech.mode == "browser"
    assert case.speech.language == "ar-EG"
    assert set(cfg.pricing) == {"claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5"}
    assert cfg.speech_pricing == {"openai": Decimal("0.006"), "elevenlabs": Decimal("0.006")}
    assert cfg.providers.anthropic.api_key_env == "ANTHROPIC_API_KEY"


def test_prices_are_exact_decimals(tmp_path: Path) -> None:
    cfg = load_config(write(tmp_path), ENV)

    # 0.10 and 1.25 are floats in YAML; they must not carry binary error into money.
    assert cfg.pricing["claude-haiku-4-5"] == ModelPrice(
        input=Decimal("1.00"),
        output=Decimal("5.00"),
        cache_write=Decimal("1.25"),
        cache_read=Decimal("0.10"),
    )
    assert str(cfg.pricing["claude-haiku-4-5"].cache_read) == "0.1"


def test_unpriced_model_is_an_error(tmp_path: Path) -> None:
    path = write(tmp_path, lambda d: use_case(d).update(model="claude-x"))

    with pytest.raises(ConfigError, match=r"apps\.connections\.use_cases\.person_add\.model"):
        load_config(path, ENV)


def test_per_request_model_is_allowed(tmp_path: Path) -> None:
    path = write(tmp_path, lambda d: use_case(d).update(model="per-request"))

    cfg = load_config(path, ENV)

    assert cfg.apps["connections"].use_cases["person_add"].model == "per-request"


def test_server_speech_needs_a_priced_provider(tmp_path: Path) -> None:
    path = write(
        tmp_path, lambda d: use_case(d).update(speech={"mode": "server", "provider": "foo"})
    )

    with pytest.raises(ConfigError, match="speech"):
        load_config(path, ENV)


def test_server_speech_needs_a_configured_provider(tmp_path: Path) -> None:
    # elevenlabs is priced but not configured under `providers`.
    path = write(
        tmp_path, lambda d: use_case(d).update(speech={"mode": "server", "provider": "elevenlabs"})
    )

    with pytest.raises(ConfigError, match=r"person_add\.speech\.provider"):
        load_config(path, ENV)


def test_server_speech_with_a_priced_configured_provider_loads(tmp_path: Path) -> None:
    path = write(
        tmp_path,
        lambda d: use_case(d).update(
            speech={"mode": "server", "provider": "openai", "language": "ar"}
        ),
    )

    cfg = load_config(path, ENV)

    assert cfg.apps["connections"].use_cases["person_add"].speech.provider == "openai"


def test_server_speech_per_request_provider_is_allowed(tmp_path: Path) -> None:
    path = write(
        tmp_path,
        lambda d: use_case(d).update(speech={"mode": "server", "provider": "per-request"}),
    )

    cfg = load_config(path, ENV)

    assert cfg.apps["connections"].use_cases["person_add"].speech.provider == "per-request"


def test_server_speech_without_a_provider_is_an_error(tmp_path: Path) -> None:
    path = write(tmp_path, lambda d: use_case(d).update(speech={"mode": "server"}))

    with pytest.raises(ConfigError, match=r"person_add\.speech"):
        load_config(path, ENV)


def test_missing_key_hash_env_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="AG_CONNECTIONS_KEY_HASH"):
        load_config(write(tmp_path), {})


def test_error_never_contains_secret_values(tmp_path: Path) -> None:
    with pytest.raises(ConfigError) as e:
        load_config(write(tmp_path), {"AG_CONNECTIONS_KEY_HASH": "s3cr3t-value"})

    assert "s3cr3t-value" not in str(e.value)
    assert r"apps.connections.key_hash_env" in str(e.value)


@pytest.mark.parametrize("bad", ["A" * 64, "a" * 63, "a" * 65, "g" * 64, ""])
def test_key_hash_must_be_64_lowercase_hex(tmp_path: Path, bad: str) -> None:
    with pytest.raises(ConfigError, match=r"apps\.connections\.key_hash_env"):
        load_config(write(tmp_path), {"AG_CONNECTIONS_KEY_HASH": bad})


def test_duplicate_key_hash_across_apps_is_an_error(tmp_path: Path) -> None:
    def add_second_app(d: dict[str, Any]) -> None:
        second = copy.deepcopy(d["apps"]["connections"])
        second["key_hash_env"] = "AG_TRIAL_KEY_HASH"
        d["apps"]["other"] = second

    with pytest.raises(ConfigError, match=r"apps\.other\.key_hash_env") as e:
        load_config(write(tmp_path, add_second_app), {**ENV, "AG_TRIAL_KEY_HASH": HASH_A})

    assert HASH_A not in str(e.value)


@pytest.mark.parametrize("bad", [-0.1, 1.01, 5])
def test_warn_at_outside_0_1_is_an_error(tmp_path: Path, bad: float) -> None:
    def set_warn(d: dict[str, Any]) -> None:
        d["apps"]["connections"]["budget"]["warn_at"] = bad

    with pytest.raises(ConfigError, match=r"apps\.connections\.budget\.warn_at"):
        load_config(write(tmp_path, set_warn), ENV)


def test_unknown_timezone_is_an_error(tmp_path: Path) -> None:
    def set_tz(d: dict[str, Any]) -> None:
        d["apps"]["connections"]["timezone"] = "Mars/Olympus"

    with pytest.raises(ConfigError, match=r"apps\.connections\.timezone"):
        load_config(write(tmp_path, set_tz), ENV)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("max_output_tokens", 0),
        ("max_output_tokens", 64001),
        ("max_audio_seconds", 0),
        ("max_audio_seconds", 601),
        ("effort", "extreme"),
    ],
)
def test_use_case_bounds_are_enforced(tmp_path: Path, field: str, value: object) -> None:
    path = write(tmp_path, lambda d: use_case(d).update({field: value}))

    with pytest.raises(ConfigError, match=rf"person_add\.{field}"):
        load_config(path, ENV)


def test_unknown_field_is_an_error(tmp_path: Path) -> None:
    path = write(tmp_path, lambda d: use_case(d).update(max_output_token=5))

    with pytest.raises(ConfigError, match=r"person_add\.max_output_token"):
        load_config(path, ENV)


def test_negative_price_is_an_error(tmp_path: Path) -> None:
    def set_price(d: dict[str, Any]) -> None:
        d["pricing"]["claude-haiku-4-5"]["input"] = -1

    with pytest.raises(ConfigError, match=r"pricing\.claude-haiku-4-5\.input"):
        load_config(write(tmp_path, set_price), ENV)


def test_bad_speech_price_names_its_path(tmp_path: Path) -> None:
    def set_price(d: dict[str, Any]) -> None:
        d["pricing"]["speech"]["openai"]["per_minute"] = "free"

    with pytest.raises(ConfigError, match=r"pricing\.speech\.openai\.per_minute"):
        load_config(write(tmp_path, set_price), ENV)


def test_app_for_key_hash(tmp_path: Path) -> None:
    def add_trial(d: dict[str, Any]) -> None:
        trial = copy.deepcopy(d["apps"]["connections"])
        trial["key_hash_env"] = "AG_TRIAL_KEY_HASH"
        d["apps"]["connections-trial"] = trial

    cfg = load_config(write(tmp_path, add_trial), ENV)

    found = cfg.app_for_key_hash(HASH_B)
    assert found is not None
    assert found[0] == "connections-trial"
    assert found[1] is cfg.apps["connections-trial"]
    assert cfg.app_for_key_hash("c" * 64) is None
    assert cfg.app_for_key_hash("") is None
    assert cfg.app_for_key_hash("é" * 64) is None


def test_missing_file_is_a_config_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="missing.yaml"):
        load_config(tmp_path / "missing.yaml", ENV)


def test_invalid_yaml_is_a_config_error(tmp_path: Path) -> None:
    path = tmp_path / "bad.yaml"
    path.write_text("apps: [unclosed", encoding="utf-8")

    with pytest.raises(ConfigError, match="not valid YAML"):
        load_config(path, ENV)


def test_non_mapping_top_level_is_a_config_error(tmp_path: Path) -> None:
    path = tmp_path / "list.yaml"
    path.write_text("- a\n- b\n", encoding="utf-8")

    with pytest.raises(ConfigError, match="mapping"):
        load_config(path, ENV)


def test_committed_files_load() -> None:
    for name in ("local.yaml", "production.yaml"):
        cfg = load_config(CONFIG_DIR / name, FAKE_ENV)
        assert "connections" in cfg.apps
        assert cfg.apps["connections"].use_cases["person_add"].model == "claude-haiku-4-5"

    local = load_config(CONFIG_DIR / "local.yaml", FAKE_ENV)
    assert set(local.apps) == {"connections", "connections-trial"}
    assert local.apps["connections-trial"].use_cases["eval"].model == "per-request"
    assert set(load_config(CONFIG_DIR / "production.yaml", FAKE_ENV).apps) == {"connections"}
