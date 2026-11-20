# ADR-0001: Contributor links write through narrow SECURITY DEFINER functions

- **Status:** Accepted, 2026-11-20 (v0.1, Task 10). Spec §8.2 and §11.4.
- **Context:** Every other request path is authorised by row-level security. The verified Supabase
  JWT carries `network_id`, `member_role` and `person_id`, and each table's policies compare against
  them (`20261119000003_rls.sql`). Link contributors (spec §8.2) are people the owner trusts but who
  have no account, so they have no session and no JWT. RLS has nothing to identify them by. Their
  requests run as Postgres `anon`, which holds no privilege on any table. The blueprint allows a
  narrow, documented exception to "RLS decides everything". This is that record.
- **Decision:**
  - **Hashed, expiring, revocable tokens.** `POST /api/v1/links` makes `secrets.token_urlsafe(32)`
    and stores only its sha256 in `contributor_link.token_hash`, with the person, `expires_at`
    (30 days, the column default) and `revoked_at`. The URL `WEB_PUBLIC_URL/c#<token>` is returned
    once and never stored. Renewing writes a new hash and resets the 30 days, so the old token stops
    working. A revoked link stays revoked (`409 link_revoked` on renew).
  - **The token stays out of URLs and logs.** It sits in the URL fragment, which browsers never
    send, and the page strips it from the address bar. Requests carry it in `X-Contributor-Token`.
    The API hashes it first and passes only the hash to the database. SlowAPI logs its bucket key, so
    that key is the hash too. Log redaction masks any field whose name contains `token`.
  - **Three definer functions, anon only.** `contributor_link_info`, `contributor_tag_suggest` and
    `contribute_person` (`20261119000008`) are `SECURITY DEFINER` with `search_path = ''` and names
    qualified by schema. Execute is revoked from `public`, `anon` and `authenticated`, then granted
    to `anon` alone. Each one first checks the link: it exists, is not revoked, and
    `expires_at > now()`. Each one then uses the link's `network_id` and `person_id`. The functions
    run as their owner, which bypasses RLS (ruling R4).
  - **Insert-only, and it reads nothing back.** `contribute_person` inserts a person
    (`created_via = 'link'`, `contributor_link_id`, `created_by_person_id` set to the link's person).
    It also inserts their skills (through `upsert_tag`), industries, social links and contact values
    (`added_by_person_id` set to the link's person), plus one connection to the link's person. It
    returns only the new id. `contributor_link_info` returns the contributor's display name and the
    expiry. `contributor_tag_suggest` returns tag labels, which are not sensitive and keep
    contributors on existing spellings. No function returns any other row. The read-back the
    contributor sees on the page (spec §8.2) is what they just submitted, held in the page's memory.
  - **The database does not trust the API.** `contribute_person` checks the payload again. It allows
    only known keys (never `admin_notes` or provenance), JSON types, enum values, text lengths, list
    sizes, and at least one name. All of this happens before anything is written. The API's
    `ContributorPersonInput` has the same rules, so a client hears 422 first.
  - **One answer for every bad token.** A missing, malformed, unknown, expired or revoked token
    takes the same code path, hashing and the database call included. Every case ends in the same
    `404 link_not_found` body.
  - **Rate limited.** Each `/api/v1/contribute/*` endpoint allows 30 requests a minute per token
    hash and 60 a minute per client IP (SlowAPI, `shared/rate_limit.py`).
  - **No `service_role`.** Contributor requests run in `user_tx({})` as `anon`.
- **Rejected:**
  - Using `service_role` on the contributor path: one bug there could reach every table.
  - Minting a short-lived JWT for the contributor and adding `anon`/link policies to every table.
    The policy surface grows on every table, and a policy cannot keep a contributor insert-only as
    simply as a function can.
  - Storing the plaintext token, or putting it in the path or query: it would end up in the
    database, proxy logs and browser history.
  - Telling expired links apart from unknown ones: it tells a guesser which tokens once existed.
  - A review queue before submissions go live: the owner's call (spec §8.2). Contributors are a
    trusted circle, and the admin can edit or delete what they add.
- **Consequences:**
  - The three functions are the whole contributor attack surface. Any new contributor capability
    needs its own narrow function and an update to this ADR, never a wider function or an anon
    grant on a table.
  - The functions depend on their owner bypassing RLS. The hosted first deploy (Task 17) must
    smoke-test a contributor submission (ruling R4).
  - Behind a reverse proxy, uvicorn must trust the forwarded client address, or every contributor
    shares one per-IP budget.
  - The payload rules exist twice: `links/schemas.py` and `contribute_person`. They must change
    together.
  - Tests: `apps/api/tests/integration/test_contributor_links.py`. It covers fragment URLs,
    hash-only storage, the same 404 for every bad token, renew and revoke, anon reading no table,
    SQL-side payload checks, rate limits, and the token never appearing in logs.
