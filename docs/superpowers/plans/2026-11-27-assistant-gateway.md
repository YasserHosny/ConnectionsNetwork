# Assistant Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Assistant Gateway, a standalone HTTP service for speech-to-text, Claude calls
and hard per-app spending caps, together with the framework-free `<ag-voice-capture>` widget.

**Architecture:**
- A FastAPI service in `apps/assistant-gateway/` that never imports from `apps/api`.
- Configuration is a committed YAML file; secrets come from environment variables.
- Every metered call goes *reserve, call, settle* against a ledger in the `assistant_gateway`
  Postgres schema, serialized per app by a transaction-scoped advisory lock.
- Providers (Anthropic; OpenAI speech) sit behind small protocols, so tests use fakes and CI makes
  no network calls.
- The widget is a plain TypeScript Web Component in the same folder.

**Tech Stack:**
- Python 3.12, FastAPI 0.115.6, pydantic v2, psycopg 3, SlowAPI, PyYAML, the `anthropic` SDK,
  httpx, and PyAV (audio duration).
- TypeScript, vitest and jsdom for the widget.
- uv and pnpm, as elsewhere in the repo.

**Spec:** `docs/superpowers/specs/2026-11-27-voice-assistant-design.md`. This plan covers Part A
(sections 6.x), the widget (section 7) and the gateway's share of section 13 step 1. Two more plans
follow:
- the model trial (Part C), in `2026-11-27-voice-add-trial.md`;
- voice add in Connections (Part B), in `2026-11-27-voice-add.md`.

## Global Constraints

**The service**
- Python `>=3.12,<3.13`. Ruff `line-length = 100`, `select = ["E","F","I","B","UP","ANN"]`, the
  same as `apps/api/pyproject.toml`.
- No module under `apps/assistant-gateway/src/` imports `connections_api`. A guard test enforces
  this (Task 1).
- Error bodies use the same envelope as `apps/api`: `{"code", "message", "details", "trace_id"}`
  (`apps/api/src/connections_api/errors.py:ErrorEnvelope`).
  - This corrects the spec's `{error: {...}}` wording. Task 1 fixes the spec line.

**The database**
- Every psycopg connection sets `prepare_threshold=None`. `AG_DATABASE_URL` is Supabase's
  transaction pooler, the same reason as `apps/api/src/connections_api/db.py`.
- Money is `Decimal` in Python and `numeric(12,6)` in SQL. Every cost is rounded **up**
  (`ROUND_CEILING`) to 6 decimal places.
- A stale reservation expires after **15 minutes** and keeps counting at its reserved amount.

**Storage and logging**
- Nothing stores or logs prompt text, context, messages, model output, transcripts or audio.
  Logs carry the trace id, method, path, status, app, use case, cost and error code only.

**Claude**
- Model ids are only the exact strings `claude-haiku-4-5`, `claude-sonnet-5-5` and
  `claude-opus-5-5`, plus any other id the config prices.
- No server-side `fallbacks`. Every model a request can run on must be in the pricing table.
- Fixed numbers for Claude calls:
  - input overhead constant: **4096 tokens**, added to the UTF-8 byte count of every LLM request;
  - Anthropic client timeout: **30 s**, `max_retries=1`.

**Limits**
- Per app key: **60 requests/minute** per endpoint.
- Request body caps:

  | Field | Cap |
  |---|---|
  | `end_user_id` | 1–128 characters |
  | `messages` | 1–40 items |
  | Each message's `content` | 20 000 characters |
  | Audio upload | 10 MB |

**Environment and deployment**
- Environment variables:
  - `AG_ENV` (`local` / `staging` / `production`)
  - `AG_CONFIG_PATH`
  - `AG_DATABASE_URL`
  - plus every `*_env` name the config refers to
- Port **8100**. In production it is reached on `localhost:8100` from `connections-api`, and it has
  **no public endpoint**.

## Review Focus

1. **The provider times out after the request was sent.** Anthropic may still bill it, so the
   reservation must keep counting (status `unknown`), never be released. Test in Task 7.
2. **The month and day boundaries are in the app's timezone, not UTC.** A call at
   2026-11-30 22:30 UTC is 2026-12-01 00:30 in Africa/Cairo, so it counts in December. Test in
   Task 5.
3. **The owner lowers a cap below what has already been spent.** `status` must report
   `exhausted: true` and every metered call must be refused, with no negative remaining and no
   crash. Test in Task 5.
4. **The audio comes from Chrome's MediaRecorder,** whose WebM has no duration header. The duration
   must be measured from the packets, not read as 0, or the audio would be priced at zero. Test in
   Task 8.
5. **Speech recognition ends on its own after silence,** which Chrome on Android does. The widget
   must emit the final transcript and go back to idle, not stay stuck on "listening". Test in
   Task 11.

---

## File Structure

```
apps/assistant-gateway/
  pyproject.toml, uv.lock
  config/local.yaml              # dev config (fake key hashes via env)
  config/production.yaml         # caps/models for the Connections app; committed, no secrets
  migrations/0001_ledger.sql
  src/assistant_gateway/
    settings.py                  # env → Settings
    config.py                    # YAML → GatewayConfig (validation)
    pricing.py                   # cost maths (pure)
    db.py                        # connect()
    migrate.py                   # migration runner, `python -m assistant_gateway.migrate`
    ledger.py                    # reserve / settle / release / mark_unknown / snapshot / usage
    periods.py                   # month/day window in a timezone
    errors.py                    # GatewayError family + envelope handlers
    logging.py                   # JSON logs, trace id, no bodies
    auth.py                      # app key → AppContext dependency
    rate_limit.py                # SlowAPI keyed by app key hash
    audio.py                     # duration from packets (PyAV)
    providers/llm.py             # LlmProvider protocol, LlmResult, Usage
    providers/anthropic_llm.py   # AnthropicProvider
    providers/speech.py          # SpeechProvider protocol, SpeechResult
    providers/openai_speech.py   # OpenAiSpeechProvider
    routes/health.py, llm.py, speech.py, status.py, usage.py
    main.py                      # create_app(settings, config, llm, speech_providers)
  tests/conftest.py
  tests/unit/…, tests/integration/…
  web/
    package.json, tsconfig.json, vitest.config.ts
    src/voice-capture.ts, src/voice-capture.spec.ts
infra/docker/assistant-gateway.Dockerfile
docs/operations/assistant-gateway.md
```

---

### Task 1: Scaffold the service, health check, CI wiring

**Files:**
- Create:
  - `apps/assistant-gateway/pyproject.toml`
  - `apps/assistant-gateway/src/assistant_gateway/{__init__.py,settings.py,main.py,routes/__init__.py,routes/health.py,errors.py,logging.py}`
  - `apps/assistant-gateway/tests/conftest.py`
  - `apps/assistant-gateway/tests/unit/test_health.py`
  - `apps/assistant-gateway/tests/unit/test_isolation.py`
- Modify:
  - `package.json` (scripts)
  - `.github/workflows/ci.yml` (the lint job and the backend-tests job)
  - `docs/superpowers/specs/2026-11-27-voice-assistant-design.md` (the error envelope line in 6.2)

**Interfaces:**
- Produces:
  - `Settings(ag_env, ag_config_path: Path, ag_database_url: SecretStr)` and `get_settings()`.
    Same pattern as `apps/api` config: no defaults, `hide_input_in_errors`.
  - `create_app(settings: Settings | None = None, *, config: GatewayConfig | None = None, llm: LlmProvider | None = None, speech: Mapping[str, SpeechProvider] | None = None) -> FastAPI`.
    Later tasks add the parameters as they appear; Task 1 takes only `settings`.
  - `errors.GatewayError(status_code, code, safe_message)` plus `register_exception_handlers(app)`.
    The envelope is `{code, message, details, trace_id}`.
  - `logging.configure_logging()`, `TraceIdMiddleware` and `get_trace_id()`. Copy them from
    `apps/api/src/connections_api/shared/logging.py`, minus the contact-value patterns.

- [ ] **Step 1: Write the failing tests**

```python
def test_healthz_ok(client):
    r = client.get("/healthz")
    assert r.status_code == 200 and r.json() == {"status": "ok"}

def test_unknown_route_uses_envelope(client):
    body = client.get("/nope").json()
    assert set(body) == {"code", "message", "details", "trace_id"}

def test_no_connections_api_imports():
    src = Path(__file__).parents[2] / "src"
    offenders = [p for p in src.rglob("*.py") if "connections_api" in p.read_text()]
    assert offenders == []
```

`conftest.py` sets the obviously-fake environment, as `apps/api/tests/conftest.py` does, and
provides a `client` fixture (`TestClient(create_app())`).

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --project apps/assistant-gateway pytest apps/assistant-gateway/tests -q`

Expected: FAIL, with a collection error because `assistant_gateway` is not importable.

- [ ] **Step 3: Write `pyproject.toml` and the modules above**

- Dependencies:

  | Package | Version |
  |---|---|
  | `fastapi` | `==0.115.6` |
  | `uvicorn[standard]` | `==0.34.0` |
  | `pydantic` | `>=2.10,<3` |
  | `pydantic-settings` | `>=2.7,<3` |
  | `psycopg[binary]` | `>=3.2,<4` |
  | `slowapi` | `==0.1.9` |
  | `httpx` | `==0.28.1` |
  | `pyyaml` | `>=6,<7` |
  | `anthropic` | latest 1.x |
  | `av` | `>=14,<15` |

- Dev dependencies: `pytest==8.3.4`, `ruff`.
- Hatch wheel `packages = ["src/assistant_gateway"]`.
- Run `uv lock` inside `apps/assistant-gateway`.

- [ ] **Step 4: Wire the scripts and CI**

- Root `package.json`:
  - `"test:gateway": "uv run --project apps/assistant-gateway pytest apps/assistant-gateway/tests"`
  - `"lint:gateway": "uv run --project apps/assistant-gateway ruff check apps/assistant-gateway"`
- `ci.yml` lint job: add a "Lint gateway" step running the lint command above.
- `ci.yml` backend-tests job: add "Run gateway tests" with the same `TEST_DATABASE_URL`.
- Spec 6.2: replace `{error: {code, message}}` with `{code, message, details, trace_id}`.

- [ ] **Step 5: Run the tests and lint**

Run: `pnpm test:gateway && pnpm lint:gateway`

Expected: 3 passed, and ruff clean.

- [ ] **Step 6: Commit**

```bash
git add apps/assistant-gateway package.json .github/workflows/ci.yml docs/superpowers/specs/2026-11-27-voice-assistant-design.md
git commit -m "feat(gateway): scaffold the Assistant Gateway service with a health check"
```

---

### Task 2: Configuration file and its validation

**Files:**
- Create:
  - `src/assistant_gateway/config.py`
  - `src/assistant_gateway/pricing.py` (`ModelPrice` only)
  - `config/local.yaml`
  - `config/production.yaml`
  - `tests/unit/test_config_file.py`

**Interfaces:**
- Produces:
  - `load_config(path: Path, env: Mapping[str, str]) -> GatewayConfig`. It raises `ConfigError`
    with a message that names the YAML path of the fault and never includes a secret.
  - `pricing.ModelPrice(input: Decimal, output: Decimal, cache_write: Decimal, cache_read: Decimal)`,
    a frozen dataclass in USD per million tokens. This task creates `pricing.py` holding only this
    class, and Task 3 adds the functions.
  - `GatewayConfig`:
    - `pricing: dict[str, ModelPrice]`
    - `speech_pricing: dict[str, Decimal]` (per minute)
    - `providers: ProvidersConfig`
    - `apps: dict[str, AppConfig]`
  - `AppConfig`:
    - `key_hash: str` (resolved from `key_hash_env`; 64 hex characters)
    - `timezone: ZoneInfo`
    - `budget: BudgetConfig(monthly_cap_usd: Decimal, per_user_daily_cap_usd: Decimal | None, warn_at: Decimal)`
    - `use_cases: dict[str, UseCaseConfig]`
  - `UseCaseConfig`:
    - `model: str`, where `"per-request"` is allowed
    - `effort: Literal["low","medium","high","xhigh","max"] | None`
    - `max_output_tokens: int` (1–64000)
    - `max_input_chars: int`
    - `cap_usd: Decimal | None`
    - `speech: SpeechConfig(mode: Literal["browser","server"], provider: str | None, language: str | None)`
    - `max_audio_seconds: int` (1–600, default 60)
  - `GatewayConfig.app_for_key_hash(h: str) -> tuple[str, AppConfig] | None`

- [ ] **Step 1: Write the failing tests**

Each test writes a small YAML file into `tmp_path`.

```python
def test_valid_file_loads(tmp_path): ...  # pricing for 3 models, one app, one use case
    assert cfg.apps["connections"].budget.monthly_cap_usd == Decimal("5.00")
    assert cfg.apps["connections"].timezone == ZoneInfo("Africa/Cairo")

def test_unpriced_model_is_an_error(tmp_path):   # use case model claude-x not in pricing
    with pytest.raises(ConfigError, match=r"apps\.connections\.use_cases\.person_add\.model"): ...

def test_server_speech_needs_a_priced_provider(tmp_path):  # mode server, provider foo unpriced
    with pytest.raises(ConfigError, match="speech"): ...

def test_missing_key_hash_env_is_an_error(tmp_path):  # env lacks AG_CONNECTIONS_KEY_HASH
    with pytest.raises(ConfigError, match="AG_CONNECTIONS_KEY_HASH"): ...

def test_error_never_contains_secret_values(tmp_path):  # bad hash value "s3cr3t-value"
    with pytest.raises(ConfigError) as e: ...
    assert "s3cr3t-value" not in str(e.value)

def test_duplicate_key_hash_across_apps_is_an_error(tmp_path): ...

def test_warn_at_outside_0_1_is_an_error(tmp_path): ...

def test_committed_files_load():   # config/local.yaml and config/production.yaml with fake env
    for name in ("local.yaml", "production.yaml"): load_config(CONFIG_DIR / name, FAKE_ENV)
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm test:gateway -- -k config_file`

Expected: FAIL with an ImportError.

- [ ] **Step 3: Implement `config.py` and the two YAML files**

- Parse with `yaml.safe_load`, then the pydantic models. Map each pydantic `loc` to a dotted path
  for `ConfigError`.
- `production.yaml` defines:
  - app `connections`: `monthly_cap_usd: 5.00`, `per_user_daily_cap_usd: 1.00`, `warn_at: 0.8`;
  - use case `person_add`: `claude-haiku-4-5`, `max_output_tokens: 2000`, `max_input_chars: 20000`,
    `speech: {mode: browser, language: ar-EG}`.
  - It must say in a comment that the caps are placeholders the owner sets.
- `local.yaml` holds the same app, plus app `connections-trial` from spec 6.1 with
  `monthly_cap_usd: 5.00`.
- Prices come from spec 6.1. Speech per-minute values are `0.006` and marked
  `# placeholder: check the provider's price before enabling`.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm test:gateway -- -k config_file`

Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -m "feat(gateway): YAML configuration with fail-fast validation"`

---

### Task 3: Cost maths

**Files:**
- Modify: `src/assistant_gateway/pricing.py` (`ModelPrice` comes from Task 2)
- Create: `tests/unit/test_pricing.py`

**Interfaces:**
- Produces:
  - `Usage(input_tokens: int, output_tokens: int, cache_read_input_tokens: int = 0, cache_creation_input_tokens: int = 0)`
  - `INPUT_OVERHEAD_TOKENS = 4096`
  - `llm_cost(price: ModelPrice, usage: Usage) -> Decimal`
  - `llm_worst_case(price: ModelPrice, input_bytes: int, max_output_tokens: int) -> Decimal`
    - `(input_bytes + INPUT_OVERHEAD_TOKENS) × max(price.input, price.cache_write) + max_output_tokens × price.output`, all over 1e6.
    - Every input token is priced at the dearer of uncached input and cache write.
  - `speech_cost(per_minute: Decimal, seconds: Decimal) -> Decimal`
  - All three round up to 6 decimal places.

- [ ] **Step 1: Write the failing tests**

```python
HAIKU = ModelPrice(Decimal("1"), Decimal("5"), Decimal("1.25"), Decimal("0.10"))

def test_llm_cost_prices_each_token_kind():
    u = Usage(input_tokens=1000, output_tokens=200, cache_read_input_tokens=3000, cache_creation_input_tokens=500)
    assert llm_cost(HAIKU, u) == Decimal("0.002925")  # .001 + .001 + .0003 + .000625

def test_worst_case_uses_dearer_input_rate_and_overhead():
    assert llm_worst_case(HAIKU, input_bytes=10_000, max_output_tokens=2000) == Decimal("0.027620")

def test_worst_case_counts_bytes_not_characters():
    arabic = "مهندس برمجيات" * 100
    assert llm_worst_case(HAIKU, len(arabic.encode()), 0) > llm_worst_case(HAIKU, len(arabic), 0)

def test_costs_round_up():
    assert speech_cost(Decimal("0.006"), Decimal("0.5")) == Decimal("0.000050")
    assert llm_cost(HAIKU, Usage(1, 0)) == Decimal("0.000001")
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm test:gateway -- -k pricing`

Expected: FAIL.

- [ ] **Step 3: Add `Usage`, `INPUT_OVERHEAD_TOKENS` and the three functions to `pricing.py`**

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm test:gateway -- -k "pricing or config_file"`

Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -m "feat(gateway): cost maths with a guaranteed worst-case estimate"`

---

### Task 4: Database connection and migrations

**Files:**
- Create:
  - `src/assistant_gateway/db.py`
  - `src/assistant_gateway/migrate.py`
  - `migrations/0001_ledger.sql`
  - `tests/integration/conftest.py`
  - `tests/integration/test_migrate.py`

**Interfaces:**
- Produces:
  - `db.connect(dsn: str | None = None, **kw) -> psycopg.Connection`. It always sets
    `prepare_threshold=None`.
  - `migrate.apply(conn) -> list[str]`, which returns the versions it applied.
  - `migrate.pending(conn) -> list[str]`
  - `python -m assistant_gateway.migrate` applies migrations using `AG_DATABASE_URL`.
- Table `assistant_gateway.ledger_entry`:

  | Column | Type |
  |---|---|
  | `id` | `uuid pk default gen_random_uuid()` |
  | `app` | `text not null` |
  | `use_case` | `text not null` |
  | `end_user_id` | `text not null` |
  | `kind` | `text check in ('llm','speech')` |
  | `model` | `text not null` (the model id or speech provider name) |
  | `status` | `text check in ('reserved','settled','released','expired','unknown')` |
  | `reserved_usd` | `numeric(12,6) not null` |
  | `actual_usd` | `numeric(12,6)` |
  | `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | `int` |
  | `audio_seconds` | `numeric(8,2)` |
  | `error_code` | `text` |
  | `created_at` | `timestamptz not null default now()` |
  | `settled_at` | `timestamptz` |

  - Index `(app, created_at)`.
  - Index `(app, status, created_at)` where `status = 'reserved'`.
- Table `assistant_gateway.schema_migrations(version text pk, applied_at timestamptz)`.

- [ ] **Step 1: Write the failing tests**

Database tests skip when `TEST_DATABASE_URL` is unset, the same rule as `apps/api`. The integration
`conftest.py` drops and recreates schema `assistant_gateway` once per session, then calls
`migrate.apply`.

```python
def test_apply_is_idempotent(conn):
    assert migrate.apply(conn) == []          # session fixture already applied everything
    assert migrate.pending(conn) == []

def test_ledger_rejects_unknown_status(conn):
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("insert into assistant_gateway.ledger_entry (app,use_case,end_user_id,kind,model,status,reserved_usd) values ('a','u','e','llm','m','bogus',0)")

def test_connect_disables_prepared_statements():
    with db.connect(TEST_DSN) as c: assert c.prepare_threshold is None
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm db:test && TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54329/postgres pnpm test:gateway -- -k migrate`

Expected: FAIL.

- [ ] **Step 3: Implement**

- `migrate.apply`:
  1. runs `create schema if not exists assistant_gateway` and creates `schema_migrations`;
  2. takes `pg_advisory_xact_lock(hashtextextended('assistant_gateway:migrate', 0))`;
  3. applies the files in `migrations/*.sql` not yet recorded, in filename order with `LC_ALL=C`
     semantics (sorted by name), each in its own transaction.
- `migrations/` sits beside `src/`, and the wheel's `force-include` copies it into the package as
  `assistant_gateway/migrations`.

- [ ] **Step 4: Run them and see them pass**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -m "feat(gateway): ledger schema and migration runner"`

---

### Task 5: The ledger: reserve, settle, release, caps

**Files:**
- Create:
  - `src/assistant_gateway/periods.py`
  - `src/assistant_gateway/ledger.py`
  - `tests/unit/test_periods.py`
  - `tests/integration/test_ledger.py`

**Interfaces:**
- Consumes: `db.connect` and the `ledger_entry` table (Task 4); `AppConfig` and `UseCaseConfig`
  (Task 2).
- Produces:
  - `periods.month_window(now: datetime, tz: ZoneInfo) -> tuple[datetime, datetime]` and
    `day_window(...)`. Both return UTC-aware half-open bounds.
  - `ledger.Caps(app_monthly: Decimal, use_case_monthly: Decimal | None, user_daily: Decimal | None)`,
    built by `Caps.for_use_case(app: AppConfig, use_case: UseCaseConfig)`.
  - `class BudgetExhausted(Exception)`, with `cap: Literal["app_monthly","use_case_monthly","user_daily"]`.
  - `ledger.reserve(conn, *, app: str, use_case: str, end_user_id: str, kind: Literal["llm","speech"], model: str, amount: Decimal, caps: Caps, tz: ZoneInfo, now: datetime | None = None) -> UUID`.
    It runs its own transaction:
    1. take `pg_advisory_xact_lock(hashtextextended('assistant_gateway:app:' || app, 0))`;
    2. expire stale reservations (`status='reserved' and created_at < now - 15 min` becomes
       `expired`);
    3. check each cap;
    4. insert the reservation, or raise `BudgetExhausted`.
  - `ledger.settle(conn, entry_id, *, actual_usd: Decimal, usage: Usage | None = None, audio_seconds: Decimal | None = None, error_code: str | None = None) -> None`
  - `ledger.release(conn, entry_id, *, error_code: str) -> None`
  - `ledger.mark_unknown(conn, entry_id, *, error_code: str) -> None`. The entry keeps counting
    `reserved_usd`.
  - `ledger.snapshot(conn, *, app: str, cap_usd: Decimal, warn_at: Decimal, tz: ZoneInfo, now: datetime | None = None) -> BudgetSnapshot(used_usd: Decimal, cap_usd: Decimal, warning: bool, exhausted: bool)`
- **Spend rule.** Spend in a window is
  `sum(actual_usd where status='settled') + sum(reserved_usd where status in ('reserved','expired','unknown'))`.
  - A cap passes when `spend + amount ≤ cap`.
  - `warning` is `used ≥ warn_at × cap`.
  - `exhausted` is `used ≥ cap`.

- [ ] **Step 1: Write the failing tests**

```python
def test_cairo_month_boundary():  # Review Focus 2
    start, end = month_window(datetime(2026, 11, 30, 22, 30, tzinfo=UTC), ZoneInfo("Africa/Cairo"))
    assert start == datetime(2026, 11, 30, 22, 0, tzinfo=UTC)  # 2026-12-01 00:00 Cairo (UTC+2)

def test_reserve_within_cap_then_settle_counts_actual(conn): ...
    assert snapshot(...).used_usd == Decimal("0.010000")   # reserved 0.05, settled 0.01

def test_reserve_refused_when_app_cap_would_be_exceeded(conn):
    with pytest.raises(BudgetExhausted) as e: reserve(..., amount=Decimal("0.60"), caps=Caps(Decimal("1"), None, None))  # after 0.50 spent
    assert e.value.cap == "app_monthly"

def test_user_daily_and_use_case_caps_are_checked(conn): ...  # one test per cap, cap names asserted

def test_released_counts_zero_unknown_counts_reserved(conn): ...

def test_stale_reservation_expires_and_still_counts(conn):  # created_at 16 min ago
    reserve(...); assert status_of(old) == "expired"; assert snapshot(...).used_usd == old_amount + new_amount

def test_cap_lowered_below_spend(conn):  # Review Focus 3
    s = snapshot(conn, app="a", cap_usd=Decimal("0.10"), ...)   # 0.50 already settled
    assert s.exhausted and s.warning
    with pytest.raises(BudgetExhausted): reserve(..., amount=Decimal("0.000001"), caps=Caps(Decimal("0.10"), None, None))

def test_concurrent_reservations_never_exceed_cap(dsn):
    # 20 threads, own connections, each reserve 0.10 against cap 1.00
    assert successes == 10 and total_reserved(dsn, "a") <= Decimal("1.00")

def test_apps_do_not_share_caps(conn): ...
```

- [ ] **Step 2: Run them and see them fail**

Run: `TEST_DATABASE_URL=… pnpm test:gateway -- -k "ledger or periods"`

Expected: FAIL.

- [ ] **Step 3: Implement `periods.py` and `ledger.py`**

- Each window sum is one `select` inside the locked transaction.
- `now` defaults to `datetime.now(UTC)`, and it is passed into SQL as a parameter, not
  `now()`. Then tests can fix the time, and expiry uses the same clock.

- [ ] **Step 4: Run them and see them pass**

Run the same command as Step 2.

Expected: PASS, including the concurrency test.

- [ ] **Step 5: Commit**

`git commit -m "feat(gateway): budget ledger with atomic reservations and per-app caps"`

---

### Task 6: App keys, rate limit and `GET /v1/status`

**Files:**
- Create:
  - `src/assistant_gateway/auth.py`
  - `src/assistant_gateway/rate_limit.py`
  - `src/assistant_gateway/routes/status.py`
  - `tests/integration/test_status_api.py`
  - `tests/unit/test_auth.py`
- Modify: `main.py` (it takes `config`, and stores it on `app.state`)

**Interfaces:**
- Consumes: `GatewayConfig.app_for_key_hash` (Task 2); `ledger.snapshot` (Task 5).
- Produces:
  - `auth.AppContext(name: str, config: AppConfig)`.
  - Dependency `current_app(request) -> AppContext`:
    - the key hash is `sha256(bearer).hexdigest()`, compared with `hmac.compare_digest` against
      every configured hash;
    - a missing or unknown key gets 401 `auth.unauthenticated`.
  - `auth.use_case_of(ctx: AppContext, name: str) -> UseCaseConfig`. An unknown name gets 422
    `unknown_use_case`.
  - `rate_limit.limiter`, keyed `"app:" + sha256(b"ratelimit:" + bearer)` at `60/minute`, with
    `key_style="endpoint"`. Exceeding it gets 429 `rate_limited` in the envelope.
  - `GET /v1/status?use_case=&end_user_id=` returns
    `{"speech": {"mode","language"}, "available": bool, "budget": {"used_usd","cap_usd","warning","exhausted"}}`.
    - `budget` is the **app monthly** cap.
    - `available` is `not exhausted`.
  - **Money in JSON** is a JSON number (`float(decimal_value)`) on every route. For example,
    `Decimal("1.200000")` becomes `1.2`. The ledger keeps the exact `Decimal`.

- [ ] **Step 1: Write the failing tests**

```python
def test_status_requires_a_known_key(client):
    assert client.get("/v1/status", params=Q).status_code == 401
    assert client.get("/v1/status", params=Q, headers=bearer("wrong")).json()["code"] == "auth.unauthenticated"

def test_status_reports_mode_and_budget(client, seed_spend):  # 4.10 settled of 5.00
    body = client.get("/v1/status", params=Q, headers=bearer(KEY)).json()
    assert body == {"speech": {"mode": "browser", "language": "ar-EG"}, "available": True,
                    "budget": {"used_usd": 4.1, "cap_usd": 5.0, "warning": True, "exhausted": False}}

def test_unknown_use_case_is_422(client): ...

def test_rate_limit_is_per_app_key(client):   # 61st call → 429 rate_limited; other key still 200
```

- [ ] **Step 2: Run them and see them fail**

Run: `TEST_DATABASE_URL=… pnpm test:gateway -- -k "status or auth"`

Expected: FAIL.

- [ ] **Step 3: Implement**

The test `conftest.py` builds a config whose key hash env holds the `sha256` of
`"test-app-key-not-real"`.

- [ ] **Step 4: Run them and see them pass**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -m "feat(gateway): app keys, per-app rate limit and the status endpoint"`

---

### Task 7: Claude adapter and `POST /v1/llm/messages`

**Files:**
- Create:
  - `src/assistant_gateway/providers/{__init__,llm,anthropic_llm}.py`
  - `src/assistant_gateway/routes/llm.py`
  - `tests/unit/test_anthropic_llm.py`
  - `tests/integration/test_llm_api.py`
  - `tests/fakes.py`
- Modify: `main.py` (it takes `llm: LlmProvider`, defaulting to `AnthropicProvider` from config)

**Interfaces:**
- Consumes:
  - `pricing.llm_worst_case`, `llm_cost`, `Usage` (Task 3);
  - `ledger.reserve`, `settle`, `release`, `mark_unknown`, `snapshot`, `Caps` (Task 5);
  - `current_app` and `use_case_of` (Task 6).
- Produces:
  - `LlmResult(text: str, usage: Usage, stop_reason: str, model: str)`
  - Protocol `LlmProvider.complete(*, model: str, system: str, context: str | None, messages: list[dict[str, str]], output_schema: dict | None, max_output_tokens: int, effort: str | None) -> LlmResult`
  - The provider raises one of two errors, both defined in `providers/__init__.py`, so the
    speech providers in Task 8 share them:
    - `ProviderRejected(code)`: the request was refused before generation (4xx, 529). It is
      safe to release.
    - `ProviderUncertain(code)`: a timeout or dropped connection. It may have been billed.
  - `AnthropicProvider(api_key: str)` builds `anthropic.Anthropic(api_key=..., timeout=30.0, max_retries=1)`
    and calls `client.messages.create` with:
    - `system=[{"type":"text","text":system,"cache_control":{"type":"ephemeral"}}]`, plus
      `{"type":"text","text":context}` when there is context;
    - `output_config={"format":{"type":"json_schema","schema":output_schema}}` when there is a
      schema;
    - `output_config["effort"]=effort` only for models in
      `EFFORT_MODELS = {"claude-sonnet-5-5","claude-opus-5-5"}`;
    - **no** `thinking` parameter and **no** `fallbacks`.
  - `tests/fakes.FakeLlm(result | exception)` records its calls.
  - **Request:**
    `LlmRequest(use_case, end_user_id, system: str, context: str | None, messages: list[LlmMessage], output_schema: dict | None, model: str | None)`
    - `LlmMessage(role: Literal["user","assistant"], content: str)`
    - The caps are in Global Constraints.
  - **Response:**
    `{"output": <parsed JSON or text>, "model", "usage": {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}, "cost_usd", "budget": {...}}`
- **Route flow:**
  1. Resolve the model: `model` is honored only for `per-request` use cases, and must be priced
     (otherwise 422 `model_not_allowed`).
  2. Check the size: the total characters of system, context and messages must be at most
     `max_input_chars`, otherwise 413 `input_too_large`.
  3. Compute `input_bytes` as the UTF-8 length of system, context, every message content and
     `json.dumps(output_schema)`.
  4. Reserve the worst case. `BudgetExhausted` becomes 429 `budget_exhausted` with
     `details={"cap": e.cap}`.
  5. Call `complete`, then branch:

     | Outcome | Ledger | Answer |
     |---|---|---|
     | `ProviderRejected` | `release` | 502 `provider_unavailable` |
     | `ProviderUncertain` | `mark_unknown` | 502 `provider_unavailable` |
     | `stop_reason == "refusal"` | `settle` | 502 `provider_refused` |
     | `stop_reason == "max_tokens"`, or the schema output is not valid JSON | `settle` | 502 `provider_bad_output` |
     | Otherwise | `settle` | 200 |

  The routes are sync (`def`), like `apps/api`, so FastAPI runs them in its threadpool.

- [ ] **Step 1: Write the failing tests**

```python
# unit, with a stub client object standing in for anthropic.Anthropic().messages
def test_system_is_cached_and_context_follows(): ...
    assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"} and kwargs["system"][1]["text"] == "CTX"
def test_effort_only_on_models_that_take_it(): ...  # haiku: no "effort" key; sonnet-5-5: effort == "low"
def test_no_thinking_and_no_fallbacks_sent(): assert "thinking" not in kwargs and "fallbacks" not in kwargs
def test_timeout_maps_to_uncertain(): ...  # anthropic.APITimeoutError → ProviderUncertain
def test_rate_limit_maps_to_rejected(): ... # anthropic.RateLimitError → ProviderRejected

# integration, with FakeLlm
def test_happy_path_settles_actual_cost(client, conn):
    r = post_llm(client, FakeLlm(LlmResult('{"ok":true}', Usage(1000, 200), "end_turn", "claude-haiku-4-5")))
    assert r.status_code == 200 and r.json()["output"] == {"ok": True} and r.json()["cost_usd"] == 0.002
    assert ledger_rows(conn) == [("settled", Decimal("0.002000"))]

def test_budget_exhausted_never_calls_provider(client): ...  # cap 0.01, worst case larger → 429, fake.calls == []
def test_timeout_keeps_reservation_counting(client, conn):  # Review Focus 1
    r = post_llm(client, FakeLlm(ProviderUncertain("timeout")))
    assert r.status_code == 502 and ledger_rows(conn)[0][0] == "unknown"
def test_rejected_releases(client, conn): ...
def test_refusal_and_bad_json_are_settled_502(client, conn): ...
def test_model_override_only_for_per_request_use_case(client): ...
def test_input_too_large_is_413(client): ...
def test_prompt_text_never_logged(client, caplog):
    post_llm(client, FakeLlm(...), system="MARKER-7f3a"); assert "MARKER-7f3a" not in caplog.text
```

- [ ] **Step 2: Run them and see them fail**

Run: `TEST_DATABASE_URL=… pnpm test:gateway -- -k "llm"`

Expected: FAIL.

- [ ] **Step 3: Implement the adapter, the route and the fakes**

Map the anthropic exceptions:
- `APITimeoutError` and `APIConnectionError` become `ProviderUncertain`;
- `RateLimitError`, `BadRequestError`, `AuthenticationError`, `PermissionDeniedError` and
  `NotFoundError` become `ProviderRejected`;
- `InternalServerError` and any other `APIStatusError` become `ProviderUncertain`.

- [ ] **Step 4: Run them and see them pass**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -m "feat(gateway): metered Claude calls with structured output"`

---

### Task 8: Speech providers and `POST /v1/speech/transcribe`

**Files:**
- Create:
  - `src/assistant_gateway/audio.py`
  - `src/assistant_gateway/providers/{speech,openai_speech}.py`
  - `src/assistant_gateway/routes/speech.py`
  - `tests/unit/test_audio.py`
  - `tests/unit/test_openai_speech.py`
  - `tests/integration/test_speech_api.py`
- Modify: `main.py` (it takes `speech: Mapping[str, SpeechProvider]`, built from
  `config.providers`)

**Interfaces:**
- Consumes: `pricing.speech_cost` (Task 3); the ledger (Task 5); auth (Task 6);
  `ProviderRejected` and `ProviderUncertain` (Task 7).
- Produces:
  - `audio.duration_seconds(data: bytes) -> Decimal`. It opens the data with
    `av.open(io.BytesIO(data))`, demuxes every packet of the first audio stream, and returns
    `max(pts + duration) × time_base`, rounded up to 0.01. If it cannot parse the data, or finds no
    audio stream, it raises `UnsupportedAudio`.
  - `SpeechResult(text: str)`, and the protocol
    `SpeechProvider.transcribe(audio: bytes, mime: str, language: str | None) -> SpeechResult`,
    with a `name: str` attribute.
  - `OpenAiSpeechProvider(api_key: str, model: str, client: httpx.Client | None = None)`:
    - posts multipart to `https://api.openai.com/v1/audio/transcriptions` with the fields `model`,
      `file`, `language` (when given) and `response_format=json`, and reads `text`;
    - its timeouts are 30 s;
    - `httpx.TimeoutException` becomes `ProviderUncertain`, and a 4xx becomes `ProviderRejected`.
  - `POST /v1/speech/transcribe` takes multipart `file`, `use_case`, `end_user_id`, and the
    optional `language` and `provider`:
    - If the use case's speech `mode` is `browser`: 409 `speech_mode_browser`.
    - Upload over 10 MB: 413 `audio_too_large`.
    - `UnsupportedAudio`: 415 `unsupported_audio`.
    - Duration over `max_audio_seconds`: 413 `audio_too_long`. All of these checks happen
      **before** reserving.
    - Otherwise it reserves `speech_cost(price, duration)`, calls the provider, and settles at the
      same amount, with `audio_seconds=duration`.
    - Response: `{"text","duration_seconds","provider","cost_usd","budget"}`.
  - `provider` is honored only when the use case's speech provider is `per-request`.

- [ ] **Step 1: Write the failing tests**

Test audio is generated in the test with PyAV: 3 s of silence encoded as WebM/Opus with **no
duration in the header**, by writing to a non-seekable stream the way MediaRecorder does. There is
also a 3 s mp4/aac sample.

```python
def test_duration_measured_from_packets_without_header():   # Review Focus 4
    assert Decimal("2.9") <= duration_seconds(webm_opus_no_duration(3.0)) <= Decimal("3.1")
def test_mp4_duration(): ...
def test_garbage_is_unsupported(): with pytest.raises(UnsupportedAudio): duration_seconds(b"not audio")

def test_openai_request_shape(): ...  # httpx.MockTransport asserts URL, Authorization header, form fields

def test_browser_mode_is_409(client): ...
def test_too_long_refused_before_reserve(client, conn):  # 61 s, max 60 → 413 audio_too_long, no ledger row
def test_happy_path_prices_by_duration(client, conn):  # 3 s at 0.006/min → cost 0.0003, settled
def test_timeout_marks_unknown(client, conn): ...
```

- [ ] **Step 2: Run them and see them fail**

Run: `TEST_DATABASE_URL=… pnpm test:gateway -- -k "audio or speech"`

Expected: FAIL.

- [ ] **Step 3: Implement**

The speech registry is a dict keyed by provider name. A provider listed in config with a missing
key env fails at startup.

- [ ] **Step 4: Run them and see them pass**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -m "feat(gateway): server-side transcription priced by measured duration"`

---

### Task 9: `GET /v1/usage`

**Files:**
- Create:
  - `src/assistant_gateway/routes/usage.py`
  - `tests/integration/test_usage_api.py`
- Modify: `ledger.py` (add `usage_report`)

**Interfaces:**
- Consumes: the ledger (Task 5) and auth (Task 6).
- Produces:
  - `ledger.usage_report(conn, *, app: str, period: str, tz: ZoneInfo) -> UsageReport`, where
    `period` is `YYYY-MM`.
  - `GET /v1/usage?period=YYYY-MM` returns:

    ```json
    {"period","app","settled_usd","reserved_usd",
     "by_use_case":[{"use_case","kind","calls","input_tokens","output_tokens","audio_seconds","settled_usd","reserved_usd"}],
     "by_end_user":[{"end_user_id","calls","settled_usd","reserved_usd"}]}
    ```

    - `reserved_usd` covers `reserved`, `expired` and `unknown` entries.
    - Calls with status `released` are counted in `calls`.
    - An invalid period gets 422.
  - The report covers only the calling app.

- [ ] **Step 1: Write the failing test**

```python
def test_usage_groups_and_scopes_to_app(client, seeded):  # 2 apps, 2 use cases, mixed statuses
    body = client.get("/v1/usage", params={"period": "2026-11"}, headers=bearer(KEY)).json()
    assert body["settled_usd"] == 0.03 and body["reserved_usd"] == 0.05
    assert {r["use_case"] for r in body["by_use_case"]} == {"person_add", "eval"}
    assert all(r["end_user_id"] != "other-app-user" for r in body["by_end_user"])
```

- [ ] **Step 2: Run it and see it fail**

Run: `TEST_DATABASE_URL=… pnpm test:gateway -- -k usage`

Expected: FAIL.

- [ ] **Step 3: Implement**

The report is one grouped query per breakdown, within the month window from `periods`.

- [ ] **Step 4: Run it and see it pass**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -m "feat(gateway): monthly usage report per app"`

---

### Task 10: Startup checks and the container

**Files:**
- Create:
  - `infra/docker/assistant-gateway.Dockerfile`
  - `docs/operations/assistant-gateway.md`
  - `tests/integration/test_startup.py`
- Modify:
  - `main.py` (the lifespan)
  - `docker-compose.yml`
  - `.env.example`
  - `.github/workflows/deploy.yml`
  - `docs/operations/deploy-checklist.md` (one pointer line)

**Interfaces:**
- Consumes: `load_config` (Task 2); `migrate.pending` (Task 4).
- Produces:
  - At startup the app loads the config and checks the schema. Startup fails with a clear log line
    if the config is invalid or a migration is pending.
  - The container listens on 8100.
- Docker image `ghcr.io/<owner>/assistant-gateway`. It copies `config/` and runs uvicorn with
  one worker, for the same reason as the API: in-memory rate limits.

- [ ] **Step 1: Write the failing tests**

```python
def test_startup_refuses_pending_migration(dsn_with_fresh_schema):
    with pytest.raises(RuntimeError, match="pending migration 0001_ledger"):
        with TestClient(create_app(...)): pass
def test_startup_refuses_invalid_config(tmp_path): ...
```

- [ ] **Step 2: Run them and see them fail**

Run: `TEST_DATABASE_URL=… pnpm test:gateway -- -k startup`

Expected: FAIL.

- [ ] **Step 3: Implement the lifespan checks, the Dockerfile and the compose service**

- The Dockerfile follows `infra/docker/api.Dockerfile`: uv 0.11.0, a non-root uid 1001,
  `HEALTHCHECK` against `http://127.0.0.1:8100/healthz`, and
  `CMD uvicorn assistant_gateway.main:app --host 0.0.0.0 --port 8100 --workers 1`.
- The compose service `assistant-gateway`:
  - takes its env from `.env`;
  - sets `AG_CONFIG_PATH=/app/config/local.yaml`;
  - publishes port `127.0.0.1:8100:8100`.
- `.env.example` gains these, with comments and no real values:
  - `AG_ENV`, `AG_CONFIG_PATH`, `AG_DATABASE_URL`
  - `AG_CONNECTIONS_KEY_HASH`, `AG_TRIAL_KEY_HASH`
  - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- `deploy.yml`:
  - build and push a third image the same way as the api one;
  - add `BUNNY_GATEWAY_CONTAINER: assistant-gateway`;
  - update the third container.

- [ ] **Step 4: Write `docs/operations/assistant-gateway.md`**

It covers these one-time steps:
1. Create the role and schema:
   `create role assistant_gateway login password …; create schema assistant_gateway authorization assistant_gateway;`
   This runs on hosted Supabase in the SQL editor. `AG_DATABASE_URL` is the transaction pooler
   URL as that role.
2. Run the migrations:
   `docker run --rm -e AG_DATABASE_URL=… ghcr.io/<owner>/assistant-gateway python -m assistant_gateway.migrate`.
   They are run by hand, like the API's migrations.
3. Make an app key:
   `python -c "import secrets;print(secrets.token_urlsafe(48))"`. Its sha256 goes in
   `AG_CONNECTIONS_KEY_HASH` on the gateway container, and the key itself goes in the
   Connections API's environment (used by plan 3).
4. **Anthropic Console:** create a dedicated workspace for the gateway's API key, and set its
   monthly spend limit just above the sum of the app caps (spec 6.3).
5. Create the bunny.net container `assistant-gateway` in the Connections app. **Delete the public
   endpoint bunny.net adds for port 8100.** Set the env vars.
6. **Changing a cap or a model:** edit `config/production.yaml`, merge, and deploy.
7. **Reading spend:** `curl -H "Authorization: Bearer $KEY" localhost:8100/v1/usage?period=YYYY-MM`,
   run from the API container's shell.

Add one line to `deploy-checklist.md` pointing at this doc.

- [ ] **Step 5: Verify**

Run: `pnpm test:gateway -- -k startup && docker compose build assistant-gateway`

Expected: PASS, and the image builds.

- [ ] **Step 6: Commit**

`git commit -m "feat(gateway): startup checks, container, deploy and ops runbook"`

---

### Task 11: The `<ag-voice-capture>` widget

**Files:**
- Create in `apps/assistant-gateway/web/`:
  - `package.json` (name `@assistant-gateway/voice-capture`; scripts `build: tsc -p .`,
    `test: vitest run`, `lint: tsc -p . --noEmit`; devDependencies `typescript`, `vitest`,
    `jsdom`)
  - `tsconfig.json`
  - `vitest.config.ts`
  - `src/voice-capture.ts`
  - `src/voice-capture.spec.ts`
  - `README.md`
- Modify:
  - `pnpm-workspace.yaml` (add `'apps/assistant-gateway/web'`)
  - `pnpm-lock.yaml`
  - `.github/workflows/ci.yml` (lint job: `pnpm --filter @assistant-gateway/voice-capture test`)

**Interfaces:**
- Produces:
  - The custom element `ag-voice-capture`, registered once by importing the module. It exports
    `class VoiceCaptureElement extends HTMLElement`.
  - **Attributes:**
    - `mode`: `browser` or `server`; default `browser`
    - `language`: default `ar-EG`
    - `max-seconds`: default `60`
    - `label-start`, `label-stop`, `label-unavailable`
  - **Events** (`CustomEvent`, `bubbles` and `composed`):

    | Event | `detail` |
    |---|---|
    | `interim` | `{text}` |
    | `transcript` | `{text}` |
    | `audio` | `{blob: Blob, mimeType: string, seconds: number}` |
    | `unavailable` | `{reason: "unsupported" \| "denied" \| "error"}` |

  - **Property** `state: "idle" | "listening" | "recording" | "unavailable"`.
  - **Behaviour:**
    - **Shadow DOM:** one `<button aria-pressed>` and one `<span aria-live="polite">` for the
      interim text.
    - **Browser mode:**
      - uses `window.SpeechRecognition ?? window.webkitSpeechRecognition` with `continuous = true`,
        `interimResults = true` and `lang = language`;
      - final results build up the transcript;
      - `transcript` is emitted on stop **and** on the recognizer's own `end`;
      - `no-speech` and `aborted` errors return to `idle` without emitting `unavailable`.
    - **Server mode:**
      - uses `navigator.mediaDevices.getUserMedia({audio: true})` and `MediaRecorder`, with the
        mime type being the first supported of `audio/webm;codecs=opus` and `audio/mp4`;
      - it stops itself at `max-seconds`.
    - **The widget never calls `fetch`.**

- [ ] **Step 1: Write the failing tests** (in jsdom, with `SpeechRecognition` and `MediaRecorder`
  stubbed on `window`)

```ts
it('emits unavailable when speech recognition is missing', ...)          // reason 'unsupported', state 'unavailable'
it('streams interim text and emits the final transcript on stop', ...)    // interim 'ده أحمد', transcript 'ده أحمد سمير'
it('returns to idle and emits transcript when recognition ends by itself', ...)  // Review Focus 5
it('maps not-allowed to unavailable denied', ...)
it('records in server mode and stops itself at max-seconds', ...)         // fake timers; audio.seconds === 2 with max-seconds=2
it('picks audio/mp4 when webm is unsupported', ...)
it('never calls fetch', ...)                                              // spy on globalThis.fetch: not called
it('reflects aria-pressed while listening', ...)
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @assistant-gateway/voice-capture test`

Expected: FAIL.

- [ ] **Step 3: Implement `voice-capture.ts` and the README**

The README covers the attributes, the events, and usage examples for Angular
(`CUSTOM_ELEMENTS_SCHEMA`) and plain HTML.

- [ ] **Step 4: Run tests, lint and build**

Run: `pnpm install && pnpm --filter @assistant-gateway/voice-capture test && pnpm --filter @assistant-gateway/voice-capture lint && pnpm --filter @assistant-gateway/voice-capture build`

Expected: PASS, and `dist/voice-capture.js` plus `.d.ts` are produced.

- [ ] **Step 5: Commit**

`git commit -m "feat(gateway): framework-free voice capture web component"`

---

### Task 12: End-to-end check against real Claude (manual, gated)

**Files:**
- Create: `apps/assistant-gateway/scripts/smoke.py`

**Interfaces:**
- Consumes: the running gateway (`docker compose up assistant-gateway`) and `config/local.yaml`.
- Produces: one `POST /v1/llm/messages` call on `connections-trial/eval` with model
  `claude-haiku-4-5` and a tiny JSON schema `{"ok": boolean}`. It prints the output, `cost_usd`,
  and the `GET /v1/usage` totals.

- [ ] **Step 1: Ask the owner first.**

This spends real money: well under $0.01, against the `connections-trial` cap. It needs the
owner's `ANTHROPIC_API_KEY` in `.env`.

- [ ] **Step 2: Run the smoke script.**

Run: `uv run --project apps/assistant-gateway python apps/assistant-gateway/scripts/smoke.py`

Expected:
- `output == {"ok": true}`, and `cost_usd > 0`;
- the usage report shows one settled `eval` call;
- `usage.cache_creation_input_tokens` or `cache_read_input_tokens` is present in the response.

- [ ] **Step 3: Commit**

`git commit -m "chore(gateway): smoke script for a real Claude call"`
