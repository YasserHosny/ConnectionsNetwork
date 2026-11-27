# Voice assistant: Assistant Gateway + voice add — design

Date: 2026-11-27. Status: approved by the owner, 2026-11-27.

This design has three parts:

- **Part A, Assistant Gateway.** A standalone service any of the owner's apps can use. It turns
  speech into text, calls Claude, and enforces spending caps. It knows nothing about people or
  forms.
- **Part B, Voice add.** The first app feature built on the gateway. The admin describes a person
  by voice on the Add person page, and the form fills itself.
- **Part C, Model trial.** Sentences the owner reads aloud, plus a runner that compares speech
  providers and Claude models, so the cheapest setup that works gets picked.

## 1. Intent

Adding people is what makes the network strong (spec 2026-11-19, anti-goal: "Adding people is so
tedious that contributors stop after five"). Typing a profile on a phone is slow. The owner wants
to say "this is Ahmed, a backend engineer at Vodafone, we're close" and see the form filled. They
then fix it by hand or by voice, and save.

The owner also plans more apps later, and they may use other stacks. The voice and AI plumbing
should not be rebuilt each time:

- speech to text,
- access to Claude,
- per-app configuration,
- hard cost caps.

That plumbing becomes its own service. What a feature does with Claude, such as filling this form,
stays in the app.

Later the same assistant may help with search and export in this app. Those are out of scope here,
but the gateway must not need changes to support them.

## 2. Goals, non-goals, anti-goals

### Goals

- **Speak, then review.** The admin speaks on the Add person page, and the person form fills
  itself. They review it, correct it by hand or by speaking again, and press Save themselves.
- **The assistant answers in text.** It says what is missing and asks short questions. It never
  speaks.
- **A field template with three tiers** (section 9.3). Required fields block saving. Important
  fields are asked about once. Optional fields are filled only when mentioned.
- **Speech-to-text is configurable.**
  - The browser's built-in recognition (Web Speech API) is the default.
  - A server-side provider (OpenAI, ElevenLabs, or another) can be switched on by configuration,
    per app and per use case, without code changes in the app.
- **The Claude model is configurable** per app and per use case.
- **Hard spending caps per app that are never exceeded.** Configurable monthly cap, optional
  per-user daily cap, optional per-use-case cap, and a warning threshold.
- **A repeatable model trial** that shows accuracy, cost and latency per model and per speech
  provider on the owner's own voice.

### Non-goals (this release)

- Spoken replies (text-to-speech). The owner chose this, partly for cost.
- Connecting the new person to someone other than the admin ("Mohamed introduced me"). That is
  deferred, and the owner chose this.
- Voice on the contributor link page. A token holder with no account could spend the budget.
- Editing an existing person by voice.
- Several people in one utterance.
- Search or export by voice.
- A hands-free conversation mode.
- Saving without the admin pressing Save.
- An admin UI for the gateway's configuration. A config file is enough for one owner.
- A native mobile app. The PWA covers phone and laptop. Future native apps call the same gateway
  API.

### Anti-goals (failure even if it technically works)

- **Something the admin did not see gets saved.** The assistant only changes the form, and the
  admin saves.
- **The assistant silently overwrites a value the admin typed or corrected.** It may change a field
  only when the latest utterance asks for it.
- **Invented data.** No guessed phone numbers, no transliterated names (spec 2026-11-19 §4: no
  transliteration between Arabic and Latin script), and no level or strength the admin did not
  say.
- **Skill spelling fragments.** Saying "باك إند" creates a new "باك إند" skill next to the existing
  "Backend".
- **Any spend above the configured cap**, including under concurrent requests or after a crash.
- **Contact details or transcripts in the gateway's database or logs.**

## 3. Constraints

- **Stacks.** This app is Angular 22 PWA + FastAPI (Python 3.12) + Supabase Postgres 17. Future
  apps may use other stacks, so the gateway's contract is HTTP + JSON. Only the voice-capture
  widget is a client-side component, and it is a framework-free Web Component.
- **Hosting.** Production is one bunny.net Magic Containers app with two containers,
  `connections-api` and `connections-web`. They share localhost, the app is pinned to one
  instance, and only the web container's port 80 is public (`docs/operations/deploy-checklist.md`).
  The database is the Supabase Free plan. The gateway adds a third container (section 6.6), and
  its database is a dedicated schema in the same Postgres (section 6.5). There is no new paid
  infrastructure.
- **Languages.** The admin speaks Egyptian Arabic mixed with English terms. The UI is Arabic-first
  and right-to-left, with English available.
- **Privacy.** The network holds data about people who did not consent (spec 2026-11-19 §9).
  Section 11 covers what leaves the system.
- **Prices**, Anthropic first-party, per million tokens, input / output, as cached 2026-09-25
  (verify before relying on them):

  | Model | Input | Output |
  |---|---|---|
  | Haiku 4.5 (`claude-haiku-4-5`) | $1 | $5 |
  | Sonnet 5.5 (`claude-sonnet-5-5`) | $2 | $10 |
  | Opus 5.5 (`claude-opus-5-5`) | $4 | $20 |

  Speech provider prices must be checked when configuring. They are not assumed here.

## 4. Approaches considered

### Where the voice and AI plumbing lives

| Approach | Trade-off |
|---|---|
| **A. Standalone HTTP service (chosen)** | Works with any stack. Each app gets its own key, caps and models. Costs one more container to deploy and monitor, and adds an extra hop per call. |
| B. Library per app (Python package + web component) | No new service. But the server half is Python-only, and each language would need its own port. |
| C. Isolated module inside this API, extracted later | Cheapest now. But because future stacks may differ, the first new app would force the extraction anyway. |

The owner chose **A** because future apps may use other stacks, and each app has its own cap.

### Speech to text

| Approach | Trade-off |
|---|---|
| **Browser Web Speech API (default)** | Free, with live text as you speak, and no audio on our servers. Works in Chrome, Edge and Safari, but not Firefox. Audio goes to Google or Apple. Quality on mixed Egyptian/English speech is unknown until the trial. |
| **Server-side provider (configurable)** | Likely better on mixed speech, and works in any browser. Costs per minute, and needs a provider account and a recording upload path. |
| Phone keyboard dictation | Zero code. It works for free in the always-present text box, but there is nothing on desktop. |

The owner chose: the browser is the default, server providers are pluggable by configuration, and
the text box is always present.

### What the model returns for the form

| Approach | Trade-off |
|---|---|
| Full form state each turn | Simple, but the model can drop or alter fields the admin typed. That is an anti-goal. |
| Fine-grained patch operations (add skill, remove contact, ...) | Precise, but the schema is complex and the model makes more mistakes. |
| **Changed fields only, each list field replaced whole when it changes (my call)** | Untouched fields stay exactly as the admin left them. The schema stays close to the form. |

## 5. Architecture

```
Browser (Angular PWA)                 Connections API (FastAPI)        Assistant Gateway (FastAPI)
┌──────────────────────────┐          ┌───────────────────────┐        ┌───────────────────────────┐
│ <ag-voice-capture>       │ text     │ POST /assistant/      │ app    │ POST /v1/llm/messages     │──▶ Anthropic
│  Web Speech → live text  │────────▶│   person-draft        │ key    │ POST /v1/speech/transcribe│──▶ OpenAI / ElevenLabs …
│  (or records audio)      │ audio    │ POST /assistant/      │──────▶│ GET  /v1/status           │
│ Person form + reply text │────────▶│   transcribe          │        │ GET  /v1/usage            │
└──────────────────────────┘          │ builds prompt, checks │        │ caps · ledger · config    │
                                      │ reply, admin only     │        └────────────┬──────────────┘
                                      └───────────────────────┘                     ▼
                                                                         Postgres schema `assistant_gateway`
```

- **The browser never calls the gateway.** The app's server holds the app key, knows the
  signed-in user, and writes the prompt. That keeps keys off devices, and lets the app enforce its
  own auth (admin only here).
- **The gateway knows nothing of this app's domain.** It does not import anything from
  `apps/api`. It sees an opaque `end_user_id`, a `use_case` name, prompts and an output schema.

## 6. Part A: Assistant Gateway

Location: `apps/assistant-gateway/` in this monorepo (my call). It is Python 3.12 + FastAPI, the
same tooling as `apps/api`, with its own Dockerfile and its own tests. It never imports from other
apps. Moving it to its own repository is a later, mechanical step.

### 6.1 Configuration

There is one YAML file, its path given in an environment variable. Secrets come from environment
variables named in the file, never written in it. The gateway refuses to start on invalid config.
Changes apply on restart. Hot reload is left to the builder.

```yaml
pricing:            # USD per million tokens; per minute for speech
  claude-haiku-4-5:  {input: 1.00, output: 5.00, cache_write: 1.25, cache_read: 0.10}
  claude-sonnet-5-5: {input: 2.00, output: 10.00, cache_write: 2.50, cache_read: 0.20}
  claude-opus-5-5:   {input: 4.00, output: 20.00, cache_write: 5.00, cache_read: 0.20}
  speech:
    openai:     {per_minute: <check>}
    elevenlabs: {per_minute: <check>}

providers:
  anthropic:  {api_key_env: ANTHROPIC_API_KEY}
  openai:     {api_key_env: OPENAI_API_KEY, model: <transcription model>}
  elevenlabs: {api_key_env: ELEVENLABS_API_KEY, model: <model>}

apps:
  connections:
    key_hash_env: AG_CONNECTIONS_KEY_HASH        # hash of the app's bearer key
    timezone: Africa/Cairo                        # for daily/monthly periods
    budget:
      monthly_cap_usd: 5.00
      per_user_daily_cap_usd: 1.00                # optional
      warn_at: 0.8
    use_cases:
      person_add:
        model: claude-haiku-4-5                   # set from the trial (Part C)
        effort: low                               # ignored by models without effort
        max_output_tokens: 2000
        max_input_chars: 20000
        cap_usd: null                             # optional per-use-case monthly cap
        speech: {mode: browser, language: ar-EG}  # or {mode: server, provider: openai, language: ar}
        max_audio_seconds: 60
  connections-trial:                              # the model trial (Part C): own key, own cap
    key_hash_env: AG_TRIAL_KEY_HASH
    timezone: Africa/Cairo
    budget: {monthly_cap_usd: 5.00, warn_at: 0.8}
    use_cases:
      eval:
        model: per-request                        # the trial may name any priced model
        speech: {mode: server, provider: per-request}
        max_output_tokens: 2000
        max_audio_seconds: 60
```

The trial is a separate app entry, so its spend never uses up the Connections budget for real use.

- **Prices.** The pricing table is the source of truth for cost accounting. A model or speech
  provider that has no price is a config error.
- **Dollar values in the example** are placeholders. The owner sets the real caps.

### 6.2 API

Every request carries `Authorization: Bearer <app key>`. The gateway hashes the key and looks it
up; an unknown key gets 401. Every metered request also carries `use_case` and `end_user_id` (an
opaque string up to 128 characters). An unknown use case gets 422. Error bodies use the same
`{error: {code, message}}` shape as `apps/api`.

**`POST /v1/llm/messages`**

```json
{
  "use_case": "person_add",
  "end_user_id": "4f1c…",
  "system": "…stable instructions…",
  "context": "…per-request context, e.g. vocabulary…",
  "messages": [{"role": "user", "content": "…"}, {"role": "assistant", "content": "…"}],
  "output_schema": { "…JSON Schema…": "" },
  "model": "claude-sonnet-5-5"
}
```

- **Model.** `model` is accepted only when the use case says `model: per-request` (the trial).
  Otherwise the configured model is used. Transcription takes an optional `provider` field the same
  way.
- **Caching.** The gateway marks `system` for prompt caching.
- **Output.** With `output_schema`, the gateway uses structured outputs, and returns the parsed
  JSON or `502 provider_bad_output`.
- **Response:**

  ```json
  {"output": {...} | "text", "model": "…", "usage": {"input_tokens": 0, "output_tokens": 0,
   "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
   "cost_usd": 0.0031, "budget": {"used_usd": 1.20, "cap_usd": 5.00, "warning": false}}
  ```

**`POST /v1/speech/transcribe`**

- Takes multipart audio plus `use_case`, `end_user_id` and an optional `language`.
- It works only when the use case's speech mode is `server`. Otherwise it returns 409
  `speech_mode_browser`.
- Audio longer than `max_audio_seconds`, or larger than a size cap, is refused with 413.
- Response: `{text, duration_seconds, provider, cost_usd, budget}`.

**`GET /v1/status?use_case=…&end_user_id=…`**

Tells the app what to show:

```json
{"speech": {"mode": "browser", "language": "ar-EG"}, "available": true,
 "budget": {"used_usd": 1.2, "cap_usd": 5.0, "warning": false, "exhausted": false}}
```

It is not metered.

**`GET /v1/usage?period=2026-11`**

Totals for the calling app, by use case, by end user, and by kind (llm or speech): calls, tokens,
audio seconds and USD. Settled and still-reserved amounts are shown separately.

**`GET /healthz`** works the same way as `apps/api`'s health check.

### 6.3 Caps that are never exceeded

Every metered call follows **reserve, call, settle**.

1. **Worst-case estimate before calling.** The estimate must be an upper bound.
   - **LLM call:** `input upper bound × input price + max_output_tokens × output price`. The
     output cap covers thinking tokens, because `max_tokens` bounds all output.
   - **Input upper bound:** the UTF-8 byte length of the request text is a safe bound, because a
     token covers at least one byte. A tighter bound from the token-counting endpoint is allowed if
     it stays an upper bound. That is the builder's choice.
   - **Speech call:** `min(audio duration, max_audio_seconds) × per-minute price`.
2. **Reserve atomically.** In one database transaction that serialises per app (a row lock on the
   app's budget row, or an advisory lock):
   - add up settled cost plus open reservations for each period that applies: app month, use-case
     month, and user day;
   - if any total plus the worst case would exceed its cap, refuse with `429 budget_exhausted`,
     whose body names which cap;
   - otherwise insert a `reserved` ledger row.

   Concurrent requests therefore cannot overshoot together.
3. **Call the provider.**
4. **Settle.** Replace the reservation with the actual cost, computed from the provider's usage
   (cache reads and writes priced separately). If the call failed before anything was billed,
   release the reservation.
5. **Crashes.** A reservation still open after 15 minutes is never released silently. A sweep
   marks it `expired`, and it keeps counting at its reserved amount. Counting money that might not
   have been spent is safer than losing track of money that was.
6. **Warning.** Every metered response carries `budget.warning: true` once used spend reaches
   `warn_at` × the cap.
7. **Periods** use the app's configured timezone: calendar month and calendar day.

**Backstop outside the code.** The ops doc gets one step: create a dedicated Anthropic Console
workspace for the gateway's key, and set its monthly spend limit just above the sum of the app
caps. Do the same for any speech provider that supports limits. A bug in the ledger then still
cannot run up an unbounded bill.

### 6.4 Provider adapters

- **Speech providers** sit behind one interface:
  `transcribe(audio, mime, language) -> {text, duration_seconds}`.
  - v1 ships the interface and one server adapter: whichever provider wins the trial, or OpenAI if
    the trial is not run first.
  - A second adapter is the test of the interface. Adding a provider should mean writing one
    adapter, adding a price and adding config, with no other changes.
- **The Claude call** uses the official `anthropic` Python SDK.
  - Thinking and effort follow each model's rules. For example, Opus 5.5 cannot turn thinking off,
    and Haiku 4.5 has no effort setting.
  - The adapter maps the use case's `effort` to whatever the model accepts.
  - `stop_reason: refusal` returns `502 provider_refused`, still settled.

### 6.5 Storage

The gateway has its own database: its own schema, its own role and its own connection string. It
shares only the Postgres server, to avoid new hosting cost. Moving it to a separate database later
means changing `AG_DATABASE_URL`, and nothing else. The owner confirmed this on 2026-11-27.

- **Location.** The schema is `assistant_gateway`, in the same Postgres for now, through the
  gateway's own `AG_DATABASE_URL` with its own role. It does not use Supabase auth or RLS; it is a
  plain service schema.
- **Migrations** belong to the gateway. The builder chooses the tool, but it must not mix with
  `supabase/migrations/`. Alternatively, the gateway's migrations could live there under a clear
  prefix. Builder's call, and it must be documented.
- **Ledger rows:** id, app, use_case, end_user_id, kind, model or provider, status
  (reserved/settled/released/expired), reserved_usd, actual_usd, token counts, audio seconds,
  created_at, settled_at, error code.
- **No prompt, transcript, audio or model output is stored or logged.** Only usage metadata.

### 6.6 Security

- **Keys.** App keys are long random tokens, and only their hashes sit in config.
- **Rate limits.** A per-app request limit (for example 60/min) on top of the caps guards against
  runaway loops.
- **Exposure in v1 (my call).** The gateway runs as a third container, `assistant-gateway`, in the
  Connections bunny.net app.
  - `connections-api` reaches it on `localhost:<port>`.
  - It has **no public endpoint**. The same rule as port 8000 applies: delete the endpoint bunny.net
    adds on its own.
  - Its in-memory rate limits rely on the app's single instance, as `apps/api`'s do.
  - Locally, `docker-compose.yml` gets an `assistant-gateway` service on the compose network.
- **When a second app needs it**, the gateway moves to its own bunny.net app with a public HTTPS
  endpoint. That is a deployment change, not a code change.
  - The bearer keys, size limits and per-app rate limits are already built for that.
  - At that point, add an allowlist of the calling apps' addresses where the host allows it.
- **Size limits** on every input.

## 7. Part B: the voice-capture widget (`<ag-voice-capture>`)

The widget is a framework-free Web Component published from the gateway's folder
(`apps/assistant-gateway/web/`). It works in Angular through `CUSTOM_ELEMENTS_SCHEMA`, and in
React or plain pages.

- **Inputs:**
  - `mode`: browser or server
  - `language`
  - labels, so the host app supplies translated text
  - `max-seconds`
- **Browser mode.** Web Speech API with interim results. It shows live text, and emits
  `transcript` (final text) when the user stops.
- **Server mode.** Records with `MediaRecorder` (webm/opus, or mp4 on Safari), shows a timer, and
  emits `audio` (a Blob) when stopped. The host uploads the audio through its own server.
- **No support.** If browser mode is unsupported (Firefox), or the mic is denied, it emits
  `unavailable` and hides itself. The host's text box keeps working.
- It is accessible: a real button, `aria-pressed`, and the live text in an `aria-live` region.
- It never calls a network endpoint itself.

## 8. Part B: Voice add in Connections

### 8.1 What the admin sees

```
┌───────────────────────────────────────────────────┐
│ Add person                                        │
│ ┌───────────────────────────────────────────────┐ │
│ │ 🎤  "ده أحمد سمير، مهندس backend في فودافون…" │ │  ← live text, editable
│ │                                   [Send ➤]    │ │
│ │ 💬 How close are you: strong, normal or weak? │ │  ← assistant reply (text)
│ │    His phone number, if you know it?          │ │
│ └───────────────────────────────────────────────┘ │
│ Name (Arabic):  أحمد سمير           ● filled      │  ← fields the assistant changed
│ Profession:     مهندس برمجيات       ● filled      │     are marked until edited
│ Organization:   فودافون             ● filled      │
│ Skills:         Backend · Python (new)            │  ← "new" = not yet in the network
│ Strength:       ○ strong ○ normal ○ weak          │
│                                        [Save]     │
└───────────────────────────────────────────────────┘
```

- **Where.** The panel is on `/add` only, for the admin only. It is hidden when the gateway is not
  configured (an env var on `apps/api`) or reports `available: false`.
- **Speaking.** Pressing the mic shows live text in the text box. When speaking stops, the admin
  can edit the text and press Send. Auto-send on stop is the builder's call; my lean is no
  auto-send, so a misheard sentence can be fixed first. Typing and phone keyboard dictation go in
  the same box.
- **Replies.** The assistant's reply shows as text under the box, in the language the admin used.
- **Marking changes.** Fields the assistant changed carry a small marker until the admin edits
  them. Skills not already in the network show "(new)".
- **Busy and errors.** While a request runs, the Send button shows progress and the form stays
  editable. If the request fails, the form is untouched and the message says why. For example, at
  budget exhausted: "The assistant has reached this month's limit. You can still fill the form by
  hand."
- **Budget warning.** When `budget.warning` is true, a quiet line shows the spend.
- **Drafts.** The existing draft safety keeps working unchanged, because assistant changes are
  ordinary form changes.

### 8.2 Connections API endpoints

- **`POST /api/v1/assistant/person-draft`**
  - Admin only (`current_admin`), rate limited.
  - Body:
    - `utterance`: up to 2000 characters
    - `form`: the current form value. `connectTo` is sent only as one flag: whether the
      connection is to the admin.
    - `history`: the last 10 turns of `{utterance, reply}`
    - `declined`: fields the admin said they don't know
  - The server:
    1. loads the network's skill labels (with categories) and industry labels, aliases included
       as `alias → canonical label`, so a match through an alias resolves to the canonical tag;
    2. builds the prompt (8.3);
    3. calls the gateway (`use_case: person_add`, `end_user_id` = the admin's person id);
    4. validates the result against the form's enums and limits, and drops anything invalid;
    5. marks skills whose normalised label is not in the network as `is_new`.
  - Returns `{changes, reply, declined, budget}`.
- **`POST /api/v1/assistant/transcribe`**
  - Admin only. Used only in server speech mode.
  - Forwards the audio to the gateway and returns `{text, budget}`.
- **`GET /api/v1/assistant/status`**
  - Passes through the gateway's status for this admin.

### 8.3 The prompt and the output contract

- **System prompt.** A stable system prompt, cached by the gateway. Volatile parts (the vocabulary
  and the current form) go in `context` and `messages`. The system prompt states:
  - the form's fields and the three tiers (8.4);
  - the rules: change only what the latest utterance asks for or newly states; never invent;
    Arabic-script names go to `nameAr`, and Latin-script names only to `nameLatin`, never
    transliterated;
  - set `strength` only when the admin says it clearly. When the form's "Connected to" names
    someone other than the admin, never set or ask about `strength`; the admin sets it (my call);
  - set a skill level only when said;
  - reuse a vocabulary label when the meaning matches ("باك إند" → "Backend");
  - when no label matches, write the new skill **as the admin said it**: "كاراتيه" stays Arabic,
    and "Figma" or "user research" stays Latin. Never translate or transliterate. The owner chose
    this: a skill that ends up in both scripts is linked later with the existing alias feature;
  - choose a category for new skills;
  - phone numbers spoken as words become digits;
  - ask in `reply` for missing required fields, then for important fields not yet asked about or
    declined, and keep `reply` short.
- **Output schema** (structured output):

  ```json
  {
    "changes": { "nameAr": "…", "profession": "…", "skills": [{"label": "Backend", "category": "technical", "level": null}], "…": "…" },
    "reply": "…",
    "declined": ["profession"]
  }
  ```

  - `changes` holds only the fields that change.
  - `null` clears a field.
  - A list field (`skills`, `industries`, `contacts`, `socialLinks`, `availableFor`) appears in full
    when it changes, and is absent otherwise.
  - `declined` is the full updated set. The client keeps it and sends it back, so a declined field
    is not asked about again.

### 8.4 Field tiers

| Tier | Fields | Assistant behaviour |
|---|---|---|
| Required (save blocked without them; matches today's rules) | a name (`nameAr` or `nameLatin`), `strength` | Asks until filled. |
| Important | `profession`, `skills`, a way to reach them (`phone`/`whatsapp`) | Asks once each. "Don't know" adds the field to `declined`. |
| Optional | headline, organization, seniority, availableFor, city, country, industries, socialLinks, email, connectionNote, adminNotes | Filled only when mentioned. Never asked. |

Tier membership is a constant in the Connections API's prompt builder. It is not gateway config.

## 9. Part C: the model trial

This lives in `scripts/voice-add-trial/`. Its output decides `person_add.model`, `effort` and the
speech mode.

1. **Record.**
   - A local page, `record.html`, served on `localhost` (Web Speech needs a secure context), shows
     each case's sentences one at a time.
   - For each sentence it runs Web Speech and records audio at the same time.
   - At the end it saves a bundle: browser transcripts plus audio files.
   - Recordings stay on the owner's machine and are gitignored, because they are the owner's
     voice.
2. **Speech comparison.** The runner sends each recording through every configured server speech
   provider, via the gateway's `eval` use case. It computes the character error rate of each
   transcript, browser included, against the sentence as written.
3. **Extraction comparison.**
   - Every model × effort setting runs every case twice: once on the written sentence (a clean
     measure of the model), and once on the browser transcript (what real use looks like).
   - Multi-turn cases start each turn from the case's expected state. Then one bad turn does not
     sink the rest.
4. **Grading** (automatic, no LLM judge):
   - text fields compare after Arabic normalisation and case folding, against a list of acceptable
     values;
   - enums must match exactly;
   - skills match on label (with alternatives), and on category and level where the case cares;
   - `reply` is checked only for whether it asks about the expected missing fields.
   - **Two counts matter most:**
     - **invented**: a field filled that the case expects empty;
     - **overwritten**: a field changed that the utterance didn't touch.
5. **Report** (`report.md`), with one row per model × effort × input source:
   - field accuracy;
   - required-field accuracy;
   - invented;
   - overwritten;
   - new-skill-when-existing count;
   - average cost per case;
   - p50 and p95 latency.

   There is also one row per speech provider: character error rate, cost per minute and latency.
6. **Pick rule** (proposed, the owner can change it): the cheapest model and effort with
   invented = 0, overwritten = 0 and field accuracy ≥ 90% on browser transcripts. If none passes on
   browser transcripts but one passes on written text, the speech side is the problem, so try
   server speech.

A full run is on the order of a dollar at the prices above. The trial app is capped at $5.

**Where the trial runs.** The trial runs against a **local** gateway (`docker compose`), with
`AG_DATABASE_URL` pointing at local Postgres (`supabase start`). Trial spend is recorded there, and
the hosted ledger never sees it. It uses the real Anthropic key and any speech provider keys. The
Console workspace spend limit (6.3) stays the backstop.

### Trial cases

The owner reads the **Say** column. The trial vocabulary already contains these skills:
`Backend`, `Digital Marketing`, `Social Media Marketing`, `Figma`, `Python`.

| # | Say | Expect |
|---|---|---|
| 1 | ضيف أحمد سمير، مهندس برمجيات في فودافون، شاطر في الباك إند والبايثون، وعلاقتي بيه قوية. | nameAr أحمد سمير · profession مهندس برمجيات · organization فودافون · skills Backend, Python (existing; level unset) · strength strong · asks for phone |
| 2 | *(after 1)* لأ هو مش في فودافون، هو في أورانج. | organization أورانج · nothing else changes |
| 3 | ضيف كريم. | nameAr كريم · asks for strength, then profession/skills |
| 4 | *(after 3)* مش عارف بيشتغل إيه، سيبها. علاقتنا عادية. | strength normal · declined has profession · does not ask about profession again |
| 5 | منى عادل، دكتورة أسنان، عندها عيادة خاصة في المعادي. | nameAr منى عادل · profession طبيبة أسنان (or دكتورة أسنان) · seniority business_owner · availableFor offers_service · city القاهرة or المعادي · asks for strength |
| 6 | Add Sara Mostafa, she's a freelance UX designer, very good at Figma and user research, we're normal friends. | nameLatin Sara Mostafa · nameAr empty (no transliteration) · profession UX designer · availableFor freelance · skills Figma (existing), User research (new, Latin, technical or business) · strength normal |
| 7 | رقمه صفر واحد صفر واحد اتنين تلاتة أربعة خمسة ستة سبعة تمانية، وده واتساب كمان. | contacts phone 01012345678 and whatsapp 01012345678 |
| 8 | عم حسن السباك اللي في شبرا، شغله نضيف ومواعيده مظبوطة، معرفة ضعيفة. | nameAr حسن · profession سباك · skills سباكة (new, crafts_trades) · city القاهرة or شبرا · strength weak |
| 9 | ياسمين بتدور على شغل، بتتكلم ألماني كويس وفرنساوي بسيط. | nameAr ياسمين · availableFor job_seeking · skills ألماني (new, good, languages), فرنساوي (new, basic, languages); English labels fail |
| 10 | طارق فؤاد مدير المشتريات في السويدي، وهو صاحب القرار في التوريدات. | nameAr طارق فؤاد · profession مدير مشتريات · organization السويدي · seniority decision_maker |
| 11 | نهى شاطرة جداً في الديجيتال ماركتنج والسوشيال ميديا. | skills Digital Marketing, Social Media Marketing (both existing) · asks for strength |
| 12 | اللينكد إن بتاعه linkedin.com/in/omar-khaled | socialLinks linkedin https://linkedin.com/in/omar-khaled |
| 13 | إيميلها noha dot ali at gmail dot com | contacts email noha.ali@gmail.com |
| 14 | خالد مدرب كاراتيه وكمان بيرسم بورتريه، صاحبي من أيام الجامعة. | skills كاراتيه (new, sports), رسم بورتريه or بورتريه (new, arts_literature); English labels fail · connectionNote mentions university · strength strong, or asks (both pass) |
| 15 | رامي عنده مصنع ملابس في المحلة وبيدور على شريك للتصدير. | seniority business_owner · availableFor partner_seeking · city المحلة الكبرى or المحلة · industries ملابس (new, as said) |
| 16 | اممم استنى… لأ خلاص. | no changes · short reply |
| 17 | *(after 1)* شيل البايثون، وخليه خبير في الباك إند. | skills Backend (expert) only |

Exact expected values, alternatives and per-field "don't care" markers live in
`scripts/voice-add-trial/cases.yaml`. The builder writes it from this table.

## 10. Error and edge behaviour

| Situation | Behaviour |
|---|---|
| Gateway down or timing out | Connections returns 503 `assistant_unavailable`, the form is untouched, and a retry is offered. The gateway's own timeout to providers is about 30s. |
| Budget exhausted | 429 `budget_exhausted` passes through. The panel shows the limit message, and the mic is disabled until `status` says available. |
| Model output invalid against the schema | The gateway returns 502. Connections shows "Didn't catch that, try again". The reservation is still settled. |
| A change fails Connections' validation (bad enum, too long) | That field is dropped, and the rest apply. The reply is unchanged. |
| Browser has no Web Speech and the mode is browser | The mic is hidden, and the text box works. |
| Mic permission denied | The widget emits `unavailable` with a reason, and the panel shows a one-line hint. |
| Admin edits a field and then speaks again | The current form is sent each turn, so manual edits are the baseline the model sees. |

## 11. Privacy

What leaves the system when voice add is used:

- **Browser speech:** the admin's audio goes to Google (Chrome/Edge) or Apple (Safari) for
  recognition.
- **Server speech** (if configured): the audio goes to the chosen provider.
- **Claude:** each turn's text goes to Anthropic, under standard API data retention. It holds:
  - the utterance,
  - the current form, which may include contact details,
  - the network's skill and industry labels.
- **Never sent:** other people's data, and any data from the network other than the labels.
- **Never stored** by the gateway or by Connections: transcripts, audio or model output.
  Application logs carry request ids, status and cost only.

This is a new flow of personal data about people who did not consent (spec 2026-11-19 §9).
**The owner accepted it as written (2026-11-27):** the full current form is sent each turn,
without masking contact details or notes, and contact details may be spoken. The consent redesign
the v0.1 spec requires before any public phase must include this flow.

## 12. Testing

- **Gateway:**
  - unit tests for cost maths, the reservation logic and config validation;
  - integration tests on a real Postgres. The suite must show that N concurrent calls whose worst
    cases together exceed the cap end with spend ≤ cap.
  - tests for expiry of stale reservations;
  - provider adapters tested against recorded responses. CI makes no network calls.
- **Connections API:**
  - tests for the prompt builder (tiers, vocabulary, the declined set);
  - tests for response validation and `is_new` marking;
  - admin-only access;
  - the gateway is faked in tests.
- **Web:**
  - widget tests with mocked speech and recording APIs;
  - panel tests: changes apply, markers show, manual edits survive, budget messages show.
- **Trial:** not in CI, because it spends money. It runs by hand.

## 13. Build order and what the owner provides

1. **Gateway and widget (Parts A and the widget).** Tests run with faked providers, so nothing is
   needed from the owner yet.
2. **Owner setup:**
   - create an Anthropic Console workspace with a monthly spend limit, and a key in it;
   - optionally, add OpenAI or ElevenLabs keys for the speech comparison.
3. **Trial (Part C):** the owner records the sentences, the runner produces `report.md`, and the
   pick rule sets `person_add.model`, `effort` and the speech mode.
4. **Voice add (Part B).** It can be built during steps 2 and 3, against the faked gateway, with
   `claude-haiku-4-5` and browser speech as placeholders. It is switched on in production only
   after step 3 has set the config.

If the trial shows that the browser transcripts fail and a server provider passes, the server
adapter for that provider is built before step 4 ships.

## 14. Decided vs. left to the builder

**Decided by the owner:**

- Voice in and text out; no spoken replies.
- The assistant fills the form, and the admin reviews and saves.
- Corrections can be made by voice.
- The PWA on web and phone; no native app.
- Only people the admin knows, connected to the admin.
- Browser speech by default, with server providers configurable.
- The plumbing is a standalone service, separate from form logic, with per-app caps and models,
  because future apps may use other stacks.
- A model trial on the owner's voice picks the model.
- Personal data is sent to the speech provider and to Anthropic as is, with no masking (section 11).
- A new skill is written as the admin said it, with no translation or transliteration (8.3).

**My calls** (owner can override):

- The gateway lives in this monorepo at `apps/assistant-gateway/`.
- v1 deployment: a third container in the Connections bunny.net app, with no public endpoint.
  It moves to its own app when a second app needs it (6.6).
- The trial is its own app entry with its own cap, and it runs against a local gateway.
- Aliases go into the vocabulary.
- No strength from voice when "Connected to" is someone else.
- Python/FastAPI.
- A Postgres schema in the same database.
- Config is a YAML file, applied on restart.
- The "changed fields only" output contract.
- The field tiers in 8.4.
- No auto-send.
- Reserve, call, settle, with stale reservations counted rather than released.
- The pick rule and the 90% bar.
- The `eval` cap of $5.
- Per-user daily cap optional.
- Periods in Africa/Cairo.

**Left to the builder:**

- the migration tool and its location (6.5);
- the input upper-bound method (6.3);
- auto-send on stop;
- hot reload of config;
- the exact Web Speech interim-result handling;
- marker styling;
- which server speech adapter comes second.

**Open owner questions:** none.
