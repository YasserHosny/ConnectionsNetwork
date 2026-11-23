# ADR-0001: Contributor links write through narrow SECURITY DEFINER functions

- **Status:** Accepted, 2026-11-20 (v0.1, Task 10; dedicated role per ruling R11). Spec §8.2 and
  §11.4.
- **Context:** Every other request path is authorised by row-level security. The verified Supabase
  JWT carries `network_id`, `member_role` and `person_id`, and each table's policies compare against
  them (`20261119000003_rls.sql`). Link contributors (spec §8.2) are people the owner trusts but who
  have no account, so they have no session and no JWT. RLS has nothing to identify them by. The
  obvious role for such a request, Postgres `anon`, is the wrong one here. PostgREST exposes every
  function in `public` to `anon` under the anon key, and that key ships in the web app, so anyone
  could call an anon-executable function directly at `/rest/v1/rpc/...`, past FastAPI, its
  validation and its rate limits. The blueprint allows a narrow, documented exception to "RLS
  decides everything". This is that record.
- **Decision:**
  - **Hashed, expiring, revocable tokens.** `POST /api/v1/links` makes `secrets.token_urlsafe(32)`
    and stores only its sha256 in `contributor_link.token_hash`, with the person, `expires_at`
    (30 days, the column default) and `revoked_at`. The URL `WEB_PUBLIC_URL/c#<token>` is returned
    once and never stored. Renewing writes a new hash and resets the 30 days, so the old token stops
    working. A revoked link stays revoked (`409 link_revoked` on renew).
  - **The token stays out of URLs and logs.** It sits in the URL fragment, which browsers never
    send, and the page strips it from the address bar. It is kept for that browser tab only
    (`sessionStorage`, never `localStorage`), so a reload keeps working, and forgotten as soon as
    the API answers 404. Requests carry it in `X-Contributor-Token`.
    The API hashes it first and passes only the hash to the database. The stored hash is itself
    what the functions accept, so it must stay out of logs too. SlowAPI logs its bucket key when a
    limit is exceeded, so the per-link key is a domain-separated hash,
    `sha256(b"ratelimit:" + token)`, never the stored one. Log redaction masks any field whose
    name contains `token`.
  - **A dedicated role, reachable only through the API.** `contributor_api` is a NOLOGIN role with
    no table privilege and only `usage` on schema `public`. The API's login role (`connections_api`,
    ruling R19; `postgres` locally and in CI) is a member, with `set` and without `inherit`.
    PostgREST's `authenticator` never is. Contributor requests run in
    `db.contributor_tx()`: a transaction with `set local role contributor_api` and empty claims.
  - **Three definer functions, contributor_api only.** `contributor_link_info`,
    `contributor_tag_suggest` and `contribute_person` (`20261119000008`) are `SECURITY DEFINER`
    with `search_path = ''` and names qualified by schema. Execute is revoked from `public`, `anon`,
    `authenticated` and `service_role`, then granted to `contributor_api` alone. Hosted default
    privileges would otherwise grant new functions to the Supabase roles. Each function first
    checks the link: it exists, is not revoked, and `expires_at > now()`. Each one then uses the
    link's `network_id` and `person_id`. The functions run as their owner, which bypasses RLS
    (ruling R4).
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
    `404 link_not_found` body. A body or query that fails validation (bad `kind`, bad person) is a
    422 before the token is looked up. That tells a caller nothing about the token.
  - **Rate limited.** Each `/api/v1/contribute/*` endpoint allows 30 requests a minute per token
    hash and 60 a minute per client IP (SlowAPI, `shared/rate_limit.py`).
  - **No `service_role`.** Contributor requests run as `contributor_api`, never as `service_role`
    or `anon`.
- **Rejected:**
  - Granting the functions to `anon` and running contributor requests as `anon`. Anyone holding
    the public anon key could then call them through PostgREST, with unlimited submissions and
    unbounded trigram queries, bypassing SlowAPI. Combined with a logged token hash, a hash would
    be a usable credential.
  - Moving the functions to a schema PostgREST does not expose. That protects only while the
    exposed-schemas setting stays as it is. A role nobody outside the API can become holds
    regardless.
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
  - The functions depend on their owner bypassing RLS, and the API depends on its login role
    being a member of `contributor_api`. The hosted first deploy (Task 17) must check that the
    role exists and is granted to the API login role, and must smoke-test a contributor submission
    (rulings R4, R11).
  - Behind a reverse proxy, uvicorn must trust the forwarded client address, or every contributor
    shares one per-IP budget.
  - The payload rules exist twice: `links/schemas.py` and `contribute_person`. They must change
    together.
  - Tests: `apps/api/tests/integration/test_contributor_links.py`. It covers fragment URLs,
    hash-only storage, the same 404 for every bad token, and renew and revoke. They also cover
    `anon`, `authenticated` and `service_role` being unable to execute the functions, and
    `contributor_api` reading no table. The rest are the SQL-side payload checks, the rate limits
    (with a key that differs from the stored hash), and neither the token nor its hash appearing
    in logs.
