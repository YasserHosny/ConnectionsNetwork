# Connections Network v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.1 of the owner's private connections network. The admin adds
people and connections, contacts add people through expiring links, and the
admin searches by skill and sees the strongest path to each match.

**Architecture:** This is a pnpm + Turborepo monorepo, a trimmed copy of the
ProcurePilot blueprint. FastAPI (`apps/api`) is the only backend. Angular 22
(`apps/web`) is a PWA. Hosted Supabase provides Postgres 17 and Auth.

- Every request runs inside a transaction that switches to the `authenticated`
  (or `anon`) role and sets `request.jwt.claims`, so Postgres RLS enforces
  network scoping and visibility.
- Path finding loads the network's connections and runs Dijkstra in Python.

**Tech Stack:** Python 3.12, FastAPI, Pydantic v2, psycopg 3, python-jose,
SlowAPI, uv, ruff, and pytest. Angular 22 (standalone + signals), Angular
Material, `@ngx-translate`, and `@angular/service-worker`. Supabase (Postgres
17, Auth with TOTP MFA, CLI migrations). Docker + Nginx on bunny.net, and
GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-19-connections-network-design.md`.
Read it alongside this plan. Blueprint reference:
`/home/yasserhosny/Work/Projects/ProcurePilot` (abbreviated **PP** below).
"Copy from PP" means copy the file, rename `procurepilot` →
`connections`, and strip what this project doesn't use.

**Scope:** v0.1 only (spec §2). v0.2 (fuzzy duplicates, needs log, "Need
someone?") and v0.3 (Member accounts, claiming, CSV import) get their own
plans.

## Global Constraints

- Python `>=3.12,<3.13`; Angular 22.x; Postgres 17; versions as in PP manifests.
- Every table carries `network_id`; every table has `ENABLE` + `FORCE` RLS with `USING` + `WITH CHECK`.
- `service_role` is never used on a request path.
- Connection strength: `strong` / `normal` / `weak`. Path weights: strong = 1, normal = 2, weak = 3.
- Skill level (optional): `basic` / `good` / `expert`.
- Skill categories: technical, languages, sports, arts_literature, culture, crafts_trades, business, other.
- Seniority (optional): `employee` / `manager` / `decision_maker` / `business_owner`.
- Available for (optional, multi): `job_seeking` / `freelance` / `offers_service` / `partner_seeking`.
- Social link kinds: facebook, x, linkedin, instagram, github, website. Contact kinds: phone, whatsapp, email.
- Stale = `last_confirmed_at` older than **12 months**.
- Contributor links expire after **30 days**, renewable with one click, revocable.
- Contact values (phone/whatsapp/email) never appear in any URL our app serves, and never in logs.
- Admin endpoints require the JWT `aal` claim = `aal2` (TOTP MFA completed).
- UI: Arabic default + English, a language switch, RTL throughout; CSS logical properties only; every user-facing string comes from `packages/i18n` (en + ar).
- Online-only: a failed quick add is kept on the device as a draft.
- Phone normalization default country code: `+20` (Egypt). *(Plan-level call.)*

## Review Focus

1. **The same phone written differently.** `010 1234 5678`, `+20 10 1234 5678`, `00201012345678` and `01012345678` must normalize to one value, so they are flagged as a duplicate. Tested in Task 2.
2. **Arabic spelling variants.** `أحمد` / `احمد` / `إحمد`, `ة` / `ه`, `ى` / `ي`, diacritics and tatweel must all match each other in search and autocomplete. Tested in Tasks 2 and 8.
3. **Graph shapes.**
   - Cycles: must not loop.
   - Two equal-cost paths: the order must be deterministic.
   - A person with no path to the owner: listed as unreachable, never crashes search.
   - A second connection between the same pair: rejected by the unique pair constraint.

   Tested in Tasks 3 and 7.
4. **Merges that touch.**
   - A merge of two records connected to each other must leave no self-loop.
   - A merge of two records both connected to the same third person must leave one edge, with the stronger strength.

   Tested in Task 9.
5. **Bad contributor tokens.** Expired, revoked, unknown or malformed tokens all get the same 404, and no table is readable as `anon`. The token never reaches server logs (it travels in the URL fragment and a header). Tested in Task 10.

---

## File Structure

```
ConnectionsNetwork/
├── package.json · pnpm-workspace.yaml · turbo.json          (copy from PP, trimmed scripts)
├── .github/workflows/ci.yml · deploy.yml · backup.yml
├── supabase/config.toml · supabase/migrations/*.sql
├── packages/i18n/{en.json, ar.json, index.ts}
├── packages/domain-types/src/index.ts                       (API DTO types for the web app)
├── apps/api/
│   ├── pyproject.toml
│   ├── src/connections_api/
│   │   ├── main.py · config.py · db.py · deps.py · errors.py
│   │   ├── shared/{logging.py, rate_limit.py}
│   │   └── modules/
│   │       ├── auth/{jwt.py, jwks.py}
│   │       ├── people/{router.py, schemas.py, service.py}   (CRUD, tags, delete)
│   │       ├── graph/paths.py                               (pure Dijkstra + k-shortest)
│   │       ├── search/{router.py, schemas.py, service.py}
│   │       ├── duplicates/{router.py, schemas.py, service.py}
│   │       ├── links/{router.py, schemas.py, service.py}    (admin link mgmt + contributor endpoints)
│   │       ├── review/{router.py, service.py}               (stale + unreachable lists)
│   │       └── export/{router.py, service.py}
│   ├── scripts/bootstrap_admin.py
│   └── tests/{conftest.py, unit/, integration/}
├── apps/web/src/app/
│   ├── core/       api client, auth/session, mfa guard, i18n/dir service, draft store
│   ├── layout/     shell, top bar with language switch
│   └── features/   auth · search · people · review · links · export · contribute
├── infra/docker/{api.Dockerfile, web.Dockerfile} · infra/nginx/nginx.conf
└── docs/{adr/0001-contributor-link-exception.md, operations/backup-restore.md}
```

---

### Task 1: Monorepo, API skeleton, CI

**Files:**
- Create: root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.gitignore`, `.env.example`
- Create: `apps/api/pyproject.toml`, `src/connections_api/{main,config,db,errors}.py`, `shared/logging.py`
- Create: `.github/workflows/ci.yml`, `apps/api/tests/conftest.py`, `tests/unit/test_health.py`, `tests/unit/test_db_guard.py`

**Interfaces:**
- Produces:
  - `connections_api.db.connect(dsn: str | None = None, **kw) -> psycopg.Connection`, copied from PP `db.py`.
  - `connections_api.config.get_settings() -> Settings`. The required env vars are `API_ENV`, `API_CORS_ORIGINS`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_AUDIENCE`, `SUPABASE_JWT_ISSUER`, `DATABASE_URL` and `WEB_PUBLIC_URL`.
  - The error envelope `{code, message, details, trace_id}` from `errors.py`, with `NotFoundError`, `AuthenticationError`, `ForbiddenError`, `ConflictError` and `ValidationFailed`.
  - `GET /api/v1/health` → `{"status": "ok"}`.

- [ ] **Step 1: Write failing tests.**
  - `test_health_ok`: GET `/api/v1/health` returns 200 with `{"status":"ok"}`.
  - `test_db_guard`: grep the package; `psycopg.connect` appears only in `db.py`. This is PP's guard idea.
- [ ] **Step 2: Run** `uv run --project apps/api pytest` and expect FAIL (no app).
- [ ] **Step 3: Implement** the skeleton. Copy `db.py`, `errors.py`, `config.py` (only the vars above) and `shared/logging.py` from PP.
  - `shared/logging.py` gets a redaction filter that masks anything matching an email or a run of 8 or more digits in log records.
  - Also add `test_log_redaction`: logging `"call 01012345678 or a@b.co"` emits neither value.
- [ ] **Step 4: Run** pytest again and expect PASS.
- [ ] **Step 5: Add `ci.yml`** with jobs `secrets` (gitleaks), `lint` (ruff + `pnpm lint`, the web part becoming active in Task 12) and `backend-tests`.
  - `backend-tests` runs a `postgres:17` service, prepares the Supabase stand-ins (copy the block from PP `.github/workflows/ci.yml:386-430`: `auth.users`, roles `anon` / `authenticated` / `service_role` / `supabase_auth_admin`), applies `supabase/migrations/*.sql` in order, then runs pytest with `TEST_DATABASE_URL` set so DB tests fail rather than skip.
- [ ] **Step 6: Commit** `chore: scaffold monorepo, api skeleton and ci`.

---

### Task 2: Normalization functions (SQL)

**Files:**
- Create: `supabase/migrations/20261119000001_extensions_and_normalize.sql`
- Test: `apps/api/tests/integration/test_normalize.py`

**Interfaces:**
- Produces these immutable SQL functions:
  - `normalize_text(t text) returns text`: lowercase; Arabic folding of `أ إ آ ٱ` → `ا`, `ة` → `ه`, `ى` → `ي`, `ؤ` → `و`, `ئ` → `ي`; diacritics U+064B–U+0652 and tatweel U+0640 removed; whitespace collapsed; trimmed.
  - `normalize_phone(t text) returns text`: digits only, converted to E.164 with a default of `+20`.
  - `normalize_email(t text) returns text`: lowercased and trimmed.
  - `normalize_url(t text) returns text`: lowercased host, no scheme, no `www.`, no trailing slash, no query or fragment.
- Extensions: `pgcrypto` and `pg_trgm`.

- [ ] **Step 1: Write failing tests** (parametrized, run against the DB):
  - `normalize_text`: `'أحمد'`, `'احمد'`, `'إحمد'` and `'أَحْمَد'` all give `'احمد'`; `'فاطمة'` gives `'فاطمه'`; `'مصطفى'` gives `'مصطفي'`; `'  Marketing  '` gives `'marketing'`.
  - `normalize_phone`: `'010 1234 5678'`, `'+20 10 1234 5678'`, `'00201012345678'` and `'01012345678'` all give `'+201012345678'`; `'+44 20 7946 0958'` gives `'+442079460958'`.
  - `normalize_url`: `'https://www.LinkedIn.com/in/sara/'` and `'linkedin.com/in/sara?trk=x'` both give `'linkedin.com/in/sara'`.
- [ ] **Step 2: Run** and expect FAIL (functions missing).
- [ ] **Step 3: Implement** the functions with `translate()` / `regexp_replace()`. Phone rules: a leading `00` becomes `+`; a leading `0` becomes `+20` with the zero dropped; a leading `+` is kept; an input with no prefix and 10 or more digits gets `+20`.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(db): text, phone, email and url normalization`.

---

### Task 3: Core schema, network scoping, auth hook, admin RLS

**Files:**
- Create: `supabase/migrations/20261119000002_core_schema.sql`, `20261119000003_rls.sql`, `20261119000004_auth_hook.sql`
- Create: `supabase/config.toml` (from PP; sign-ups disabled, TOTP MFA enabled, hook pointing to `custom_access_token_hook`)
- Modify: `apps/api/src/connections_api/db.py` (add `user_tx`)
- Test: `tests/integration/test_schema_rls.py`, `tests/integration/helpers.py`

**Interfaces:**
- Produces these tables, all with `network_id uuid not null` except `network` itself:
  - `network(id, name)`.
  - `member(id, network_id, user_id → auth.users, person_id → person, role member_role ('admin','member'), status ('active','disabled'))`.
  - `person`:
    - `id`
    - `name_ar text`, `name_latin text`, with a check that at least one is set
    - `headline`, `organization`, `profession`
    - `seniority` (enum, null)
    - `available_for text[]`, checked against the 4 values
    - `city`, `country`
    - `admin_notes`
    - `photo_path` (null; unused in v0.1 UI)
    - `last_confirmed_at timestamptz default now()`
    - `created_by_person_id`
    - `created_via ('admin','link')`
    - `contributor_link_id` (null)
    - `created_at`
    - generated `search_name` = `normalize_text(coalesce(name_ar,'') || ' ' || coalesce(name_latin,''))`, with a GIN trigram index
  - `tag(id, kind ('skill','industry'), category skill_category null, label, label_norm generated, alias_of_tag_id null)`, unique `(network_id, kind, label_norm)`, with a check that category is not null iff kind is `'skill'`.
  - `person_skill(person_id, tag_id, level null, pk(person_id, tag_id))` and `person_industry(person_id, tag_id)`.
  - `social_link(id, person_id, kind, url, url_norm generated)` and `contact_value(id, person_id, kind, value, value_norm generated, added_by_person_id)`.
  - `connection(id, person_a, person_b, strength, note, created_by_person_id)`, with `check (person_a < person_b)` and unique `(network_id, person_a, person_b)`.
  - `contributor_link(id, person_id, token_hash bytea unique, expires_at, revoked_at null, created_at)`.
  - `duplicate_dismissal(person_a, person_b, check a<b, pk)`.

  All `person_id` foreign keys are `on delete cascade`. `connection` and `duplicate_dismissal` cascade on both ends. `created_by_person_id` and `added_by_person_id` are `on delete set null`.
- Produces these SQL accessors, each reading `request.jwt.claims` and returning null when absent (the PP `current_tenant_id` pattern): `current_network_id()`, `current_member_role()`, `current_person_id()`.
- Produces `custom_access_token_hook(event jsonb)`, adapted from PP `20260819000006_auth_hook.sql`. It stamps `network_id`, `member_role` and `person_id` from the active `member` row and never touches `role`.
- Produces `connections_api.db.user_tx(claims: dict[str, str]) -> ContextManager[psycopg.Connection]`. It begins a transaction, runs `set local role authenticated` (or `anon` when `claims == {}`) and `select set_config('request.jwt.claims', <json>, true)`, yields, then commits or rolls back.
- Admin policy on every table: `network_id = current_network_id() and current_member_role() = 'admin'`, for all commands.
- Test helper `helpers.make_network(conn) -> NetworkFixture(network_id, admin_person_id, admin_claims)`. It inserts a network, an `auth.users` row, the admin person and the member, and returns claims `{"sub", "network_id", "member_role":"admin", "person_id", "role":"authenticated", "aal":"aal2"}`.

- [ ] **Step 1: Write failing tests:**
  - `test_admin_sees_own_network_only`: two networks; admin A selects `person` and gets only A's rows.
  - `test_no_claims_sees_nothing`: `user_tx({})` selects 0 rows from every table.
  - `test_cross_network_insert_rejected`: admin A inserting a person with B's `network_id` raises.
  - `test_connection_pair_unique`: a second connection for the same pair raises `UniqueViolation`.
  - `test_connection_self_loop_rejected`: `person_a = person_b` raises.
  - `test_auth_hook_stamps_claims`: calling the hook with a member's `user_id` returns claims with `network_id`, `member_role`, `person_id`, and `role` unchanged.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement** the migrations and `user_tx`. Grants: `authenticated` gets select/insert/update/delete on the tables; `anon` gets nothing on the tables.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(db): core schema, network-scoped rls and auth hook`.

---

### Task 4: Member visibility RLS (roles ready for v0.3)

**Files:**
- Create: `supabase/migrations/20261119000005_member_visibility.sql`
- Test: `tests/integration/test_member_visibility.py`

**Interfaces:**
- Consumes: Task 3 tables, accessors and `helpers`.
- Produces member policies (role `member`, same network):
  - `person`: select/update/insert where `id = current_person_id()` or `created_by_person_id = current_person_id()`.
  - `contact_value`: all commands where `added_by_person_id = current_person_id()`, or the row's `person_id = current_person_id()` (the claimed-profile rule, spec §7.2).
  - `connection`: all commands where `created_by_person_id = current_person_id()`.
  - `person_skill`, `person_industry`, `social_link`: follow the `person` visibility.
  - `tag`: select within the network; insert allowed.
- Produces helper `helpers.make_member(conn, network) -> claims`.

- [ ] **Step 1: Write failing tests:**
  - `test_member_sees_only_own_contact_values`: on one Person, member X adds a phone and member Y adds an email; as X, select `contact_value` returns only the phone.
  - `test_member_cannot_see_others_people`: as X, a person created by Y is invisible.
  - `test_member_sees_all_values_on_own_profile`: as the person themselves, they see both values.
  - `test_member_cannot_escalate_added_by`: X inserting a contact value with `added_by_person_id = Y` raises.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement** the policies.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(db): member visibility policies`.

---

### Task 5: API auth and admin bootstrap

**Files:**
- Create: `modules/auth/{jwt.py, jwks.py}` (copy from PP, with `SupabaseClaims` fields `sub`, `network_id`, `member_role: Literal['admin','member']`, `person_id`, `aal`, `aud`, `iss`, `exp`), and `deps.py`
- Create: `apps/api/scripts/bootstrap_admin.py`
- Test: `tests/unit/test_deps.py`, `tests/integration/test_bootstrap_admin.py`

**Interfaces:**
- Produces:
  - `deps.current_admin(...) -> AdminContext(network_id: UUID, person_id: UUID, claims: dict[str,str])`. It returns 401 when the token is missing or invalid, 403 `mfa_required` when `aal != 'aal2'`, and 403 when `member_role != 'admin'`.
  - `deps.admin_tx(ctx: AdminContext) -> Iterator[psycopg.Connection]`, a FastAPI dependency that wraps `user_tx(ctx.claims)`.
  - The script `bootstrap_admin.py --email <email> --name-ar <n> [--name-latin <n>] [--network-name <n>]`. It looks up the existing `auth.users` row by email (the admin user is created beforehand in the Supabase dashboard), then creates the network, the admin person and the member in one transaction. It is idempotent: a second run prints "already bootstrapped" and exits 0.

- [ ] **Step 1: Write failing tests:**
  - `test_missing_token_401`.
  - `test_aal1_token_403_mfa_required`: the error `code == "mfa_required"`.
  - `test_member_role_403`.
  - `test_admin_aal2_ok`.

  Use HS256 tokens signed with the test secret, as in PP's conftest.

  - `test_bootstrap_creates_once`: two runs leave one network, one member, one person.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** Copy `jwt.py` / `jwks.py` from PP and adjust the claims model.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(api): admin auth with mfa gate and bootstrap script`.

---

### Task 6: People API (add, view, edit, confirm, delete, tags)

**Files:**
- Create: `supabase/migrations/20261119000006_upsert_tag.sql`, `modules/people/{router,schemas,service}.py`
- Test: `tests/integration/test_people_api.py`

**Interfaces:**
- Consumes: `current_admin`, `admin_tx`.
- Produces these schemas:
  - `PersonInput`:
    - `name_ar: str | None`, `name_latin: str | None` (at least one required)
    - `headline`, `organization`, `profession`
    - `seniority: Seniority | None`
    - `available_for: list[AvailableFor] = []`
    - `city`, `country`, `admin_notes`
    - `skills: list[SkillInput(label: str, category: SkillCategory, level: SkillLevel | None)]`
    - `industries: list[str]`
    - `social_links: list[SocialLinkInput(kind, url)]`
    - `contacts: list[ContactInput(kind, value)]`
  - `NewPersonRequest(person: PersonInput, connect_to_person_id: UUID, strength: Strength, connection_note: str | None)`. `connect_to_person_id` is the admin by default (spec §8.3).
  - `PersonOut`: all fields, plus `contacts` (with `added_by_person_id`), `connections: list[ConnectionOut(person_id, display_name, strength, note)]`, `is_stale: bool` and `last_confirmed_at`.
  - `CreatePersonResponse(person: PersonOut, possible_duplicates: list[DuplicateHint(person_id, display_name, matched_on: Literal['phone','whatsapp','email','social_link'])])`.
- Produces these endpoints (all admin):
  - `POST /api/v1/people` → 201 `CreatePersonResponse`.
  - `GET /api/v1/people/{id}` → `PersonOut`.
  - `PUT /api/v1/people/{id}` (body `PersonInput`; replaces skills, industries, links and contacts; resets `last_confirmed_at = now()`).
  - `POST /api/v1/people/{id}/confirm` (sets `last_confirmed_at = now()`).
  - `DELETE /api/v1/people/{id}` → 204; deleting the admin's own person is a 409 `cannot_delete_self`.
  - `POST /api/v1/connections` `{person_a, person_b, strength, note}`, plus `PATCH` / `DELETE /api/v1/connections/{id}`.
  - `GET /api/v1/tags?kind=skill|industry&q=` → up to 10 `{id, label, category}` matched on `label_norm` by prefix, then by trigram similarity; an alias resolves to its target.
- Produces the SQL function `upsert_tag(p_kind text, p_label text, p_category skill_category) returns uuid` (`security invoker`), in a new migration `20261119000006_upsert_tag.sql`. It matches on `normalize_text(label)`, resolves an alias to its target, and inserts when nothing matches. This is the single tag rule, shared by Task 10.
- Produces `people.service.upsert_tags(conn, kind, labels_with_category) -> list[UUID]`, a thin loop over `upsert_tag`.
- Produces `people.service.display_name(name_ar, name_latin) -> str` (the Arabic name when present).

- [ ] **Step 1: Write failing tests:**
  - `test_create_person_connects_to_admin`: the response person's connections include the admin with the given strength.
  - `test_create_on_behalf_connects_to_other`: `connect_to_person_id = X` makes the connection to X, not the admin.
  - `test_create_requires_a_name`: neither name set gives 422.
  - `test_create_reuses_tag_variants`: adding skills `"Marketing"` and later `" marketing "` leaves one `tag` row.
  - `test_alias_resolves`: with tag `mktg` set as an alias of `marketing`, creating with `mktg` stores the `marketing` tag id.
  - `test_possible_duplicates_on_phone`: an existing person with phone `01012345678`; creating with `+20 10 1234 5678` returns a `possible_duplicates` entry with `matched_on='phone'`.
  - `test_edit_resets_last_confirmed`: set `last_confirmed_at` to 2 years ago, then PUT; `is_stale` becomes false.
  - `test_delete_cascades`: after delete, no `contact_value`, `connection` or `person_skill` rows remain for that id.
  - `test_cannot_delete_self` gives 409.
  - `test_tags_autocomplete_arabic`: tag `تسويق`, query `"تسو"` returns it.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement** the router, schemas and service with plain SQL through `admin_tx`. The duplicate hints query compares `value_norm` / `url_norm` against existing rows in the network.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(api): people, connections and tag autocomplete`.

---

### Task 7: Graph paths (pure Python)

**Files:**
- Create: `modules/graph/paths.py`
- Test: `tests/unit/test_paths.py`

**Interfaces:**
- Produces:
  - `Edge = tuple[UUID, UUID, Strength]` and `WEIGHTS: dict[Strength, int] = {"strong": 1, "normal": 2, "weak": 3}`.
  - `build_graph(edges: Iterable[Edge]) -> Graph`, an undirected adjacency map.
  - `shortest_paths_from(graph, source: UUID) -> dict[UUID, PathResult(cost: int, path: list[UUID])]`. It uses Dijkstra with a `heapq`. Ties are broken by fewer hops, then by the lexicographic order of the path's UUID strings, so the order is deterministic. A node that can't be reached is absent from the result.
  - `k_shortest_paths(graph, source, target, k: int = 3) -> list[PathResult]`, using Yen's algorithm over simple paths.

- [ ] **Step 1: Write failing tests:**
  - `test_strong_longer_beats_weak_shorter`: owner–A weak + A–T weak (cost 6) against owner–B strong + B–C strong + C–T strong (cost 3); T's path is via B and C.
  - `test_cycle_terminates`: a triangle plus a tail gives correct costs.
  - `test_equal_cost_deterministic`: two equal paths always return the same one across 20 runs with shuffled edge order.
  - `test_unreachable_absent`: an isolated node is not in the result.
  - `test_k_shortest_returns_distinct_ordered`: three distinct simple paths, with non-decreasing costs.
  - `test_source_cost_zero`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** Graph size is thousands of nodes, so there is no caching in v0.1.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(api): weighted path finding`.

---

### Task 8: Search API

**Files:**
- Create: `modules/search/{router,schemas,service}.py`
- Test: `tests/integration/test_search_api.py`

**Interfaces:**
- Consumes: `paths.build_graph`, `shortest_paths_from`, `k_shortest_paths`, and `people.service.display_name`.
- Produces:
  - `GET /api/v1/search`. Query parameters:
    - `q` (free text matched against `search_name`, `profession`, `headline`, `organization` and tag labels, all through `normalize_text`, using trigram or substring)
    - `skill` (tag label, repeatable)
    - `category`
    - `min_level`
    - `industry`
    - `seniority`
    - `available_for`
    - `city`
    - `limit` (≤ 50, default 20)
  - It returns `list[SearchResult]`:
    - `person_id`, `display_name`, `profession`, `headline`, `city`
    - `matched_skills: list[{label, level}]`
    - `available_for`
    - `last_confirmed_at`, `is_stale`
    - `path: list[{person_id, display_name}]` (owner first, target last)
    - `cost: int | None` (null when unreachable)
    - `steps: int`
  - Ordering: reachable before unreachable; then `cost` ascending; then the highest matched skill level descending (expert > good > basic > none); then `display_name`. *(This defines "close" in spec §8.6 as equal cost.)* The owner is excluded.
  - `GET /api/v1/people/{id}/paths?k=3` → `list[{cost, path}]`.

- [ ] **Step 1: Write failing tests:**
  - `test_search_by_skill_ranks_by_cost`: two marketers, one via strong ties, one via weak ties; the strong one comes first.
  - `test_level_breaks_ties`: equal cost; the expert ranks above basic.
  - `test_filters_combine`: `industry=banking&seniority=decision_maker` returns only matching people.
  - `test_arabic_variant_query`: a person named `أحمد`, `q=احمد`, is found.
  - `test_unreachable_listed_last`: an orphan with the skill appears last with `cost=None` and an empty `path`.
  - `test_stale_flag`: `last_confirmed_at` 13 months ago gives `is_stale=True`.
  - `test_alternative_paths_endpoint` returns up to k paths, ordered.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** SQL filters the candidate people. Load every `connection` row in the network once per request, then run `shortest_paths_from(owner)` and join the two.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(api): skill search with path ranking`.

---

### Task 9: Duplicates — exact-match review and merge

**Files:**
- Create: `supabase/migrations/20261119000007_merge_persons.sql`, `modules/duplicates/{router,schemas,service}.py`
- Test: `tests/integration/test_duplicates.py`

**Interfaces:**
- Produces the SQL function `merge_persons(keep uuid, drop uuid) returns void`. It is `security invoker`, so RLS applies, and it requires the admin role.
  - Contact values move to `keep`, dropping exact `(kind, value_norm)` repeats from the same `added_by`.
  - Social links move, deduplicated by `url_norm`.
  - Skills union, keeping the higher level. Industries union.
  - Connections are re-pointed: the keep–drop edge is deleted, and for a duplicate pair the stronger strength is kept (strong > normal > weak).
  - Null scalar fields on `keep` are filled from `drop`. `available_for` becomes the union. `last_confirmed_at` becomes the greatest of the two. `drop` is deleted.
- Produces these endpoints:
  - `GET /api/v1/duplicates` → `list[DuplicatePair(a: PersonSummary, b: PersonSummary, matched_on: list[str])]`. Pairs share a `value_norm` (contact) or a `url_norm` (social link); pairs in `duplicate_dismissal` are excluded.
  - `POST /api/v1/duplicates/dismiss {a, b}`.
  - `POST /api/v1/duplicates/merge {keep, drop}` → `PersonOut`.

- [ ] **Step 1: Write failing tests:**
  - `test_pairs_from_phone_and_linkedin`.
  - `test_dismissed_pair_hidden`.
  - `test_merge_moves_everything`: contacts keep their `added_by_person_id`.
  - `test_merge_connected_pair_no_self_loop`.
  - `test_merge_shared_neighbor_keeps_stronger`: keep–N is weak and drop–N is strong; afterwards there is one keep–N edge, strong.
  - `test_merge_skill_keeps_higher_level`.
  - `test_merge_admin_self_allowed_as_keep_only`: dropping the admin's own person gives 409.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat: exact-match duplicate review and merge`.

---

### Task 10: Contributor links

**Files:**
- Create: `supabase/migrations/20261119000008_contributor_link_functions.sql`, `modules/links/{router,schemas,service}.py`, `shared/rate_limit.py`
- Create: `docs/adr/0001-contributor-link-exception.md`
- Test: `tests/integration/test_contributor_links.py`

**Interfaces:**
- Consumes: the SQL function `upsert_tag` (Task 6), and `PersonInput` (minus `admin_notes`).
- Produces these SQL functions. Both are `security definer`, use `set search_path = public`, and have execute granted to `anon` only.
  - `contributor_link_info(p_token_hash bytea) returns table(contributor_display_name text, expires_at timestamptz)`. It returns zero rows when the token is unknown, expired or revoked.
  - `contribute_person(p_token_hash bytea, p_payload jsonb) returns uuid`.
    - It validates the link exactly as `contributor_link_info` does, raising `invalid_link` otherwise.
    - It inserts the person with `created_via='link'`, `contributor_link_id` and `created_by_person_id = link.person_id`.
    - It inserts skills (through `upsert_tag`), industries, social links and contacts (`added_by_person_id = link.person_id`), plus the connection to `link.person_id` with the payload strength.
    - It returns the new id. It reads nothing else.
  - `contributor_tag_suggest(p_token_hash bytea, p_kind text, p_q text) returns table(label text, category skill_category)`. It validates the link, then returns up to 10 tag labels by prefix or trigram match. Tags are not sensitive. This keeps contributors on existing spellings (the anti-goal on skill fragmentation).
- Produces the admin endpoints:
  - `POST /api/v1/links {person_id}` → `{link_id, url, expires_at}`. Here `url = f"{WEB_PUBLIC_URL}/c#{token}"`, with `token = secrets.token_urlsafe(32)`. Only `sha256(token)` is stored. The URL is returned once and never stored.
  - `GET /api/v1/links` → `list[{link_id, person_id, display_name, expires_at, revoked_at, people_added: int}]`.
  - `POST /api/v1/links/{id}/renew`: `expires_at = now() + 30 days`, plus a new token and URL. The old token stops working.
  - `POST /api/v1/links/{id}/revoke`.
- Produces the contributor endpoints. They have no auth, and the token travels in the `X-Contributor-Token` header. They run in `user_tx({})` (`anon`).
  - `GET /api/v1/contribute/info` → `{contributor_display_name, expires_at}`.
  - `GET /api/v1/contribute/tags?kind=&q=` → `list[{label, category}]`.
  - `POST /api/v1/contribute/people {person: PersonInput, strength}` → 201 `{person_id}`.
  - Every failure (missing, malformed, unknown, expired or revoked token) → 404 `link_not_found`.
  - Rate limit: 30/minute per token hash and 60/minute per IP, using SlowAPI with the key func in `shared/rate_limit.py`.

- [ ] **Step 1: Write failing tests:**
  - `test_create_link_url_uses_fragment`: `"#"` is in the url, and the token is not in the path or query.
  - `test_only_hash_stored`: the DB row has no plaintext token.
  - `test_contribute_creates_person_connected_to_contributor`: `created_via='link'`, the connection is to the link's person, and contacts have `added_by` = the contributor.
  - `test_expired_link_404`, `test_revoked_link_404`, `test_unknown_token_404`, `test_missing_header_404`.
  - `test_renew_invalidates_old_token`.
  - `test_anon_cannot_select_tables`: in `user_tx({})`, selecting `person`, `contact_value` or `contributor_link` raises permission denied or returns 0 rows.
  - `test_contributor_tag_suggest_needs_valid_link`: a valid link returns `marketing` for `q=mar`; an expired one gives 404.
  - `test_rate_limit_429` after 30 posts in a minute with one token.
  - `test_contribute_does_not_log_token`: capture the logs during a request; the token string is absent.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** Write the ADR (context: link contributors have no JWT; decision: insert-only definer functions with hashed, expiring tokens; consequences), following the shape of PP's ADR-027.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat: contributor links with insert-only definer functions`.

---

### Task 11: Review lists and export

**Files:**
- Create: `modules/review/{router,service}.py`, `modules/export/{router,service}.py`
- Test: `tests/integration/test_review_export.py`

**Interfaces:**
- Consumes: `paths.shortest_paths_from`.
- Produces:
  - `GET /api/v1/review/stale` → people with `last_confirmed_at < now() - interval '12 months'`, oldest first.
  - `GET /api/v1/review/unreachable` → people absent from `shortest_paths_from(owner)`, excluding the owner.
  - `GET /api/v1/export?format=json` → one JSON document with every table in the network.
  - `GET /api/v1/export?format=csv` → a zip with one CSV per table.

  Both export formats are sent with `Content-Disposition: attachment` and `Cache-Control: no-store`.

- [ ] **Step 1: Write failing tests:**
  - `test_stale_threshold_12_months`: 11 months is not listed; 13 months is.
  - `test_unreachable_after_bridge_deleted`: owner–A–B; delete A; B is listed and still exists.
  - `test_export_json_contains_all_tables`.
  - `test_export_csv_zip_files`.
  - `test_export_requires_admin`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(api): stale and unreachable lists, data export`.

---

### Task 12: Web app foundation — i18n, RTL, PWA, sign-in with MFA

**Files:**
- Create: `apps/web` (Angular 22 standalone app, Material, `@ngx-translate`, `@supabase/supabase-js`, `@angular/service-worker`)
- Create: `packages/i18n/{en.json, ar.json, index.ts}`, `apps/web/scripts/check-i18n-keys.mjs` (copy from PP), `packages/domain-types/src/index.ts`
- Create: `core/{api.client.ts, auth.service.ts, mfa.guard.ts, locale.service.ts}`, `layout/shell.component.ts`, `features/auth/{login,mfa}.component.ts`
- Test: `core/locale.service.spec.ts`, `core/mfa.guard.spec.ts`

**Interfaces:**
- Produces:
  - `LocaleService.setLocale(l: 'ar' | 'en'): void`. It sets `<html lang dir>` (`rtl` for ar), persists the choice in `localStorage` inside try/catch, and defaults to `'ar'`.
  - `AuthService`: `signIn(email, password)`, `enrollTotp()`, `verifyTotp(code)`, `session` (a signal), `aal()` (a signal of `'aal1' | 'aal2' | null`).
  - `mfaGuard`: routes other than `/login`, `/mfa` and `/c` require `aal2`. With `aal1` it redirects to `/mfa`; with no session, to `/login`.
  - `ApiClient`: typed `get` / `post` / `put` / `patch` / `delete` under `/api/v1`, which attach the bearer token and map the error envelope to an `ApiError(code, message)`.
  - `domain-types`: TypeScript mirrors of the API schemas from Tasks 6, 8, 9, 10 and 11.
  - The PWA manifest (name from i18n; `dir: auto`) and `ngsw-config.json`, which caches the app shell only and never API responses.

- [ ] **Step 1: Write failing tests:**
  - `locale defaults to ar and sets dir=rtl`.
  - `switching to en sets dir=ltr and persists`.
  - `localStorage throwing does not break setLocale`.
  - `mfaGuard redirects aal1 to /mfa`.
  - `mfaGuard redirects no session to /login`.
  - `mfaGuard allows /c without session`.
- [ ] **Step 2: Run** `pnpm --filter web test` and expect FAIL.
- [ ] **Step 3: Implement.** Use CSS logical properties only. Add the `web-unit-tests` job (unit tests + production build) to `ci.yml`, and make `pnpm lint` run `check-i18n-keys.mjs`.
- [ ] **Step 4: Run** the tests and `pnpm lint`; expect PASS.
- [ ] **Step 5: Commit** `feat(web): app shell, ar/en rtl, pwa, sign-in with mfa`.

---

### Task 13: Web — quick add and edit person

**Files:**
- Create: `features/people/{person-form.component.ts, add-person.page.ts, edit-person.page.ts, tag-input.component.ts}`, `core/draft.store.ts`, `core/contact-picker.ts`
- Test: `core/draft.store.spec.ts`, `core/contact-picker.spec.ts`, `features/people/person-form.component.spec.ts`

**Interfaces:**
- Consumes: `ApiClient`, `domain-types` (`NewPersonRequest`, `CreatePersonResponse`, `PersonInput`), and `GET /api/v1/tags`.
- Produces:
  - `DraftStore`: `save(key: string, value: unknown)`, `load<T>(key): T | null` and `clear(key)`. All three are backed by `localStorage` and wrapped in try/catch.
  - `pickContact(): Promise<{name?: string, tel?: string, email?: string} | null>`. It feature-detects `navigator.contacts?.select`; the button is hidden when unsupported.
  - `PersonFormComponent` (shared by add and edit).
    - Required: a name (Arabic or Latin) and a strength.
    - The strength control shows the connection definition from i18n key `person.strength.help`. Arabic text: "أي شخص يمكنك مراسلته ويعرف من أنت. من قابلته مرة واحدة فقط: علاقة ضعيفة." (Modern Standard Arabic like the rest of the UI, owner's decision after the 2026-11-26 UX audit; it was Egyptian colloquial)
    - Optional fields are collapsed under "More details".
  - `TagInputComponent`: free text with autocomplete from an injected `suggest(kind, q) => Observable<{label, category}[]>` (admin: `/tags`; contributor: `/contribute/tags`, Task 16); a skill chip has an optional level selector.
  - The add page offers a "Connected to" person picker, defaulting to the admin (spec §8.3).

- [ ] **Step 1: Write failing tests:**
  - `draft store survives a throwing localStorage`.
  - `form invalid without any name`.
  - `failed submit saves draft and shows retry`.
  - `opening add page restores a saved draft`.
  - `successful submit clears draft`.
  - `duplicate hints from the response are shown with a link to the existing person`.
  - `contact picker button hidden when unsupported`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** The layout is mobile-first.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(web): quick add and edit with drafts and contact picker`.

---

### Task 14: Web — search, results, intro message, person page

**Files:**
- Create: `features/search/{search.page.ts, result-card.component.ts, intro-message.ts}`, `features/people/person.page.ts`
- Test: `features/search/intro-message.spec.ts`, `features/search/search.page.spec.ts`

**Interfaces:**
- Consumes: `GET /search`, `GET /people/{id}`, `GET /people/{id}/paths`, and `POST /people/{id}/confirm`.
- Produces:
  - `buildIntroMessage(locale, path: {display_name}[]): string`. It is addressed to `path[1]`, names the target `path[last]`, and names `path[last-1]` as "knows them" when the path has more than 3 nodes.
  - `whatsappUrl(phone: string, text: string): string` → `https://wa.me/<digits>?text=<encoded>`. *(This opens an external app. It is not a URL our app serves, so the no-contact-data-in-URLs rule holds.)*
  - Result card: name, profession, matched skills with levels, "available for" chips, a stale badge when `is_stale`, the path line, "Ask <first hop> for an intro" (WhatsApp if the first hop has a whatsapp/phone value, otherwise copy-to-clipboard), and "Contact directly" (shows the target's contacts).
  - Filters: category, min level, industry, seniority, available for, city.
  - Person page: the profile, one-hop connections (with strength, each linking to that person), the path from the owner, alternative paths (expandable), and buttons for edit, confirm and delete (delete asks for confirmation).

- [ ] **Step 1: Write failing tests:**
  - `intro message ar for 4-node path names first hop, target and penultimate`.
  - `intro message for 2-node path (direct) is not generated`: a direct contact shows only "Contact directly".
  - `whatsappUrl strips non-digits`.
  - `results render stale badge`.
  - `unreachable result shows "not connected to you" instead of a path`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.** The results list is laptop-friendly and stacks on a phone.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(web): search, intro requests and person page`.

---

### Task 15: Web — review screens, links management, export

**Files:**
- Create: `features/review/{duplicates.page.ts, stale.page.ts, unreachable.page.ts}`, `features/links/links.page.ts`, `features/export/export.page.ts`
- Test: `features/review/duplicates.page.spec.ts`, `features/links/links.page.spec.ts`

**Interfaces:**
- Consumes: the Task 9, 10 and 11 endpoints.
- Produces:
  - Duplicates page: the pairs side by side, with "Keep this one" on either side (merge) and "Not the same person" (dismiss).
  - Stale page: Confirm, Edit, or "Send update link" (creates a link for that person and opens WhatsApp share text).
  - Unreachable page: "Connect…" opens the connection dialog.
  - Links page: create for a person, then show the URL once with copy and WhatsApp share; list with status (active / expired / revoked) and `people_added`; renew; revoke.
  - Export page: JSON and CSV download buttons.

- [ ] **Step 1: Write failing tests:**
  - `merge sends keep/drop matching the chosen side`.
  - `link url shown once and not re-fetchable after navigation`.
  - `expired link shows renew action`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(web): review lists, link management and export`.

---

### Task 16: Web — contributor page (`/c`)

**Files:**
- Create: `features/contribute/{contribute.page.ts, contribute-api.ts}`
- Test: `features/contribute/contribute.page.spec.ts`

**Interfaces:**
- Consumes: `GET /contribute/info`, `GET /contribute/tags`, `POST /contribute/people` (header `X-Contributor-Token`), `PersonFormComponent` (contributor mode: no admin notes, no "connected to" picker), and `DraftStore`.
- Produces:
  - It reads the token from `location.hash` on load, keeps it in memory, and immediately runs `history.replaceState` to strip the hash from the address bar.
  - It greets the contributor by `contributor_display_name`, Arabic-first.
  - It loops "add another person". The session list shows only what was submitted from this page, kept in memory (spec §8.2). Nothing is fetched from the server.
  - A 404 shows "This link has expired or is no longer valid. Ask for a new one." from i18n.
  - Tag autocomplete uses `GET /contribute/tags` with the same header. `TagInputComponent` takes its suggestion source as an input.

- [ ] **Step 1: Write failing tests:**
  - `token read from hash and hash removed`.
  - `token sent in header, never in url`.
  - `404 shows expired message`.
  - `submitted people listed in session only`.
  - `failed submit keeps a draft`.
- [ ] **Step 2: Run** and expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat(web): contributor page`.

---

### Task 17: Containers, Nginx, deploy

**Files:**
- Create: `infra/docker/api.Dockerfile`, `infra/docker/web.Dockerfile`, `infra/nginx/nginx.conf` (all three copied from PP and trimmed), `.github/workflows/deploy.yml`, `docker-compose.yml` (api + web only)

**Interfaces:**
- Produces:
  - Two images: `ghcr.io/<owner>/connections-api` and `connections-web`.
  - One `deploy.yml`: on push to `main`, build and push both images, then run `BunnyWay/actions/container-update-image` for each container in one bunny.net app (`BACKEND_HOST=localhost`).
  - Nginx changes from PP:
    - The access log format omits the query string: `$request_method $uri $status`.
    - CSP `connect-src` includes `SUPABASE_URL`.
    - `ngsw-worker.js` and `index.html` are served `no-store`.

- [ ] **Step 1: Verify** `docker compose up --build` locally; `curl localhost:4200/api/v1/health` returns `{"status":"ok"}`.
- [ ] **Step 2: Verify** with `curl -I localhost:4200/` that the CSP, HSTS and `X-Frame-Options DENY` headers are present.
- [ ] **Step 3: Verify** that a request to `/api/v1/health?x=secret` leaves no `secret` in the Nginx log.
- [ ] **Step 4: Commit** `chore: containers, nginx and deploy workflow`.
- [ ] **Step 5: First deploy (by hand, owner).** Create the bunny.net app and containers once, set the `BUNNY_*` secrets, run the migrations with `supabase migration up`, create the admin user in Supabase, run `bootstrap_admin.py`, and enroll TOTP at first sign-in.

---

### Task 18: Nightly backup, keepalive, restore drill

**Files:**
- Create: `.github/workflows/backup.yml`, `docs/operations/backup-restore.md`

**Interfaces:**
- Produces `backup.yml`. It runs on a schedule `cron: "0 1 * * *"` and on `workflow_dispatch`.
  - `pg_dump --format=custom "$DATABASE_URL_SESSION"`, using the session pooler on port 5432.
  - Encrypt with `age -r "$BACKUP_AGE_RECIPIENT"`. Only the public key is in secrets; the private key stays offline with the owner and never in the repo.
  - `curl -X PUT` to bunny.net Storage at `$BUNNY_STORAGE_ZONE/backups/connections-<UTC date>.dump.age` with `AccessKey: $BUNNY_STORAGE_KEY`.
  - Keepalive: `curl -fsS "$WEB_PUBLIC_URL/api/v1/health/db"` plus `curl -fsS "$SUPABASE_URL/rest/v1/" -H "apikey: $SUPABASE_ANON_KEY"`.
  - Retention: delete objects older than 30 days in the same job.
- Modify: `main.py` to add `GET /api/v1/health/db`, which runs `select 1` through `db.connect`, with a test `test_health_db_ok`.
- Produces the runbook `backup-restore.md`: how to download, `age -d`, and `pg_restore` into a fresh local `supabase start` database, and how to check row counts against production.

- [ ] **Step 1: Write the failing test** `test_health_db_ok`, then implement and make it pass.
- [ ] **Step 2: Run** `backup.yml` with `workflow_dispatch`; expect a `.dump.age` object to appear in bunny.net Storage.
- [ ] **Step 3: Restore drill (spec §10).** Follow the runbook into a local database and compare `select count(*)` for `person`, `connection` and `contact_value` with production. They must be equal. Record the date in the runbook. This must be done **before the first contributor link is sent**.
- [ ] **Step 4: Commit** `chore: nightly encrypted backup, keepalive and restore runbook`.

---

## Spec coverage check

| Spec | Task |
|---|---|
| §2 v0.1 contents | 3–18 |
| §4 RTL / ar default / no transliteration / drafts / Free plan | 2, 12, 13, 18 |
| §6 connection definition, strengths | 3, 7, 13 |
| §7 profile fields, levels, industry, seniority, available for, last confirmed, aliases | 3, 6, 13 |
| §7.1–7.2 roles, provenance, claimed-profile rule | 3, 4 |
| §8.1 quick add + contact picker | 6, 13 |
| §8.2 contributor link, 30 days, renew, revoke, session-only read-back | 10, 15, 16 |
| §8.3 add on behalf | 6, 13 |
| §8.4 exact-match duplicates + merge | 6, 9, 15 |
| §8.6 search, ranking, stale marker, alternative paths, intro, contact directly | 7, 8, 14 |
| §8.7 person page | 14 |
| §8.8 staleness review | 11, 15 |
| §9 delete + orphans + export | 6, 11, 15 |
| §10 MFA, invite-only, rate limit, no contact data in URLs/logs, backups | 1, 5, 10, 16, 17, 18 |
| §11 stack, network_id, definer exception + ADR | 1, 3, 10, 17 |

Out of v0.1 by spec: fuzzy name duplicates, needs log, "Need someone?" (v0.2); Member sign-in, claiming, CSV import (v0.3). Member RLS (Task 4) ships now because spec §7.1 requires roles from day one.

**Deviation from spec, flagged for owner:** spec §11.1 says path finding uses recursive SQL. A recursive CTE over a weighted, cyclic graph with no depth cut-off enumerates every simple path, and that grows exponentially. Task 7 uses Dijkstra in Python over the connections loaded per request instead. It is still Postgres-only, with no graph database, which is the intent of the spec line.
