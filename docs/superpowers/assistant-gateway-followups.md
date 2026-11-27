# Assistant Gateway: decisions and open follow-ups

This file is the durable record of two things from the gateway build:

- the decisions made on the owner's behalf;
- what is still open.

It replaces the build ledger, a git-ignored planning folder that has now been deleted. The final
whole-branch review fixed seven items, so they are not repeated here:

- reserve forces READ COMMITTED isolation;
- logs carry the exception class only;
- a settle above its reservation logs a warning;
- prices must be greater than zero;
- the runbook keeps secrets out of shell history;
- the role SQL grants membership before `create schema`;
- `end_user_id` rejects control characters.

Sources:

- Spec: `docs/superpowers/specs/2026-11-27-voice-assistant-design.md` (Part A and section 7)
- Plan: `docs/superpowers/plans/2026-11-27-assistant-gateway.md`
- Runbook: `docs/operations/assistant-gateway.md`

## 1. Decisions made on the owner's behalf

Each ruling says what it costs if the owner disagrees.

- **G1, import check.** The test that `src` never imports `connections_api` inspects the imports
  with `ast`. It does not grep the text, so comments may still cite `apps/api`. Cost if wrong:
  none.
- **G2, dependency pins.** `anthropic` is pinned `>=2.14,<3` and `av` `>=19,<20`. These are the
  latest majors that resolved; the plan's version guesses were out of date. Cost if wrong: a pin
  bump.
- **G3, config and migrations at startup.** `create_app()` loads the config from the settings, and
  the lifespan refuses to start while a migration is pending. Cost if wrong: a small refactor.
- **G4, local test database.** Integration tests run against a dedicated `postgres:17` on port
  54339. CI uses its own service database. Cost if wrong: none.
- **G5, rounding tests and the worst case.**
  - Cost rounding up is proven with fractional-remainder tests.
  - The worst case prices every input token at the dearest of the input, cache-write and
    cache-read rates, so it stays an upper bound for any price table.
  - Cost if wrong: none.
- **G6, NOT NULL columns.** `ledger_entry.kind` and `status` are `NOT NULL` as well as checked.
  Cost if wrong: none.
- **G7, no Claude retries.** The Anthropic client runs with `max_retries=0`, overriding the plan's
  `max_retries=1`. A retry would hide whether a timed-out first attempt had already been billed,
  and could then release its reservation. The calling app retries instead. Cost if wrong: one
  fewer automatic retry on transient errors.
- **G8, audio checks.** These make crafted files unable to under-report their length.
  - An upload must hold exactly one stream, and it must be audio; anything else gets 415.
  - The length is the larger of the decoded samples and the packet span, rounded up.
  - Decoding stops once the length passes the cap, so an oversized file cannot tie up a worker.
  - The price and the ledger `model` use the registry key the provider was resolved by.
  - Cost if wrong: some decode CPU per upload, which the 10 MB cap bounds.
- **G9, widget recording limit.** The widget stops at exactly `max-seconds`. Hosts must set it at
  least 1 s below the gateway's `max_audio_seconds`, because the gateway rounds durations up. Cost
  if wrong: a host that forgets gets a 413 at the limit.
- **G10, smoke script not run.** `scripts/smoke.py` was checked only without a key: a local
  gateway answered 502 and released the entry. **The real-money run (under $0.01) is the owner's
  to do.** Cost if wrong: none.

Also decided during the build:

- **Lazy providers.** They are built on first use, so the app boots without keys, and a missing
  key answers 502 `provider_unavailable`.
- **New error codes.** `model_required`, `provider_required` and `invalid_period` are new.
  `provider_not_allowed` is used for an unconfigured speech provider.
- **Deploy guard.** The gateway's container update in `deploy.yml` is skipped until the repository
  variable `ASSISTANT_GATEWAY_ENABLED` is `true`. See the runbook for the order.

## 2. Open follow-ups

### Before voice add (Part B) ships the widget

- **Live text direction.** The live span needs `dir="auto"`. Mixed Arabic and Latin text can show
  in the wrong order on a left-to-right page.
- **Screen reader announcements.**
  - Interim updates are re-read by the polite live region, and the final text is not announced.
  - Cancelling a pending microphone prompt is not announced.
  - `aria-pressed` together with a changing label is announced twice.
- **Pressed state in forced-colours mode.** The pressed state is shown by colour only, which
  forced-colours mode loses.
- **Lost text on error.** `unavailable` is terminal on a transient `network` error, and it
  discards any text already heard.
- **README.** It does not say how a host consumes the package. The package is private, has no
  `exports` field, and `dist` must be built first.
- **Lockfile side effect.** The root lockfile now resolves `@angular/build`'s optional `vitest`
  peer. This affects workspace installs only.

### Gateway hardening (can wait; there is no public endpoint)

**Config**
- Duplicate YAML keys silently keep the last value.
- A non-UTF-8 file raises `UnicodeDecodeError` instead of `ConfigError`.
- The schema-error message leaves out the file path.
- A server-speech provider with no `model` is accepted.
- Browser mode silently ignores a `provider`.

**Claude calls**
- The 30 s timeout does not fit `max_output_tokens` near its 64 000 ceiling, especially on
  Opus 5.5. Each timeout keeps counting the full worst case.
- A missing `stop_reason` is treated as a normal finish.
- The effort-capable models are a hard-coded allow-list.
- After a successful provider call, a database error leaves the entry `reserved`. That
  overcounts, which is safe, but the request returns 500 and the log line is lost.

**Routes**
- The database connection opens before the rate-limit check on `status` and `usage`.
- Failed authentication is never throttled.
- There is no `Retry-After` header.
- There is no size limit on `output_schema` or the JSON body.
- `language` and `provider` have no length limit.
- Starlette spools a multipart upload to disk before the 10 MB cap applies.
- The periods `9999-12` and `0001-01` return 500 instead of 422.

**Speech**
- Per-minute speech prices are placeholders. Some providers bill by token, so set a conservative
  figure before turning server mode on.

**Ops**
- CI never builds the gateway image, so a build failure would first show up in deploy and block
  the api and web updates.
- The empty key hashes in `.env.example` make a local `docker compose up` crash-loop the gateway.
- An invalid config prints a traceback at import rather than one log line.

**Tests**
- The migrations path inside the wheel is not tested.
- Nothing guards that `TEST_DATABASE_URL` points at a test database, and the conftest drops
  schema `assistant_gateway` wherever it points.
- These cases have no tests: one key sent in different header formats, timer edges in the
  widget, and the 60 s boundary.
- The widget's spec files are not type-checked.

**Logging**
- `X-Trace-Id`: an empty value breaks the error envelope.
- Every 500 envelope and access-log line carries the same process-wide trace id.

**Smoke script**
- It uses bare indexing on the usage response.
- A `null` usage value crashes it.
- It loses the verdict if the usage request fails.
- A malformed URL gives a traceback instead of exit 2.

**Known limit**
- A WAV file whose header lies about its sample rate measures short. The provider reads the same
  header, so it would hear the audio sped up.
