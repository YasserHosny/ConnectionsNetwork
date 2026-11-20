# First deploy checklist (owner-run)

The one-time setup that connects the repository to hosted Supabase, GitHub Container Registry
(GHCR) and bunny.net Magic Containers. Nothing here is automated, and none of it was done by the
agent that wrote this file. After it, every push to `main` redeploys through
`.github/workflows/deploy.yml`.

Work top to bottom. Each step ends with how to check it. Steps 5 and 6 need a running stack, so
their smoke tests are run after step 9 (marked below).

Placeholders: `<ref>` is the Supabase project reference, `<owner>` the GitHub account or
organisation (lower case), `$SESSION_URL` the **session pooler** connection string (port 5432,
user `postgres.<ref>`), `$TX_URL` the **transaction pooler** string (port 6543).

## 1. GHCR, GitHub secrets and the bunny.net app

The images are `ghcr.io/<owner>/connections-api` and `ghcr.io/<owner>/connections-web`, tagged
`latest` and with the commit SHA. The container names `deploy.yml` updates are `connections-api`
and `connections-web` (the `BUNNY_API_CONTAINER` / `BUNNY_WEB_CONTAINER` values at the top of the
workflow); the containers must be created with exactly these names.

1. In bunny.net create **one Magic Containers app** with **two containers** in it, `connections-api`
   (port 8000) and `connections-web` (port 80), pulling the two images above. Only the web
   container's port 80 may be published as the app's endpoint. **Never publish port 8000**: the API is
   reached only through Nginx, and uvicorn trusts forwarded headers from localhost.
2. Registry: if the GHCR packages are private, add a GHCR pull registry in bunny.net (a GitHub
   token with `read:packages`) and select it for both containers. Alternatively make both packages
   public.
3. The images do not exist until the workflow has run once. Run **Actions, Deploy, Run workflow**
   once before creating the containers. It builds and pushes both images, then its two update steps
   fail because the containers are not there yet. That first failure is expected. Create the
   containers, then run the workflow again.
4. GitHub repository secrets (Settings, Secrets and variables, Actions): `BUNNY_API_KEY` (bunny.net
   account API key) and `BUNNY_APP_ID` (the app's id). `GITHUB_TOKEN` is provided by Actions.

Verify: the second workflow run is green, and the bunny.net dashboard shows both containers on the
commit SHA tag.

## 2. Hosted Supabase: run the migrations

From the repository root, with the Supabase CLI, against the **session pooler**:

```bash
supabase migration up --db-url "$SESSION_URL"
```

Never run migrations from the deploy workflow and never through the transaction pooler (it does not
keep session state). Verify: `supabase migration list --db-url "$SESSION_URL"` shows all eight
migrations (`20261119000001` to `20261119000008`) as applied, locally and remotely.

The SQL below runs in the Supabase SQL editor, or through `psql "$SESSION_URL"`.

## 3. pg_trgm must be where `public.similarity` resolves

The tag autocomplete calls `public.similarity(...)`, and an index uses `gin_trgm_ops`. Hosted
Supabase likes to put extensions in the `extensions` schema, where `public.similarity` does not
exist and tag autocomplete fails at the first request.

```sql
select e.extname, n.nspname as schema
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'pg_trgm';
select public.similarity('ahmed', 'ahmad');   -- must return a number, not an error
```

If the schema is not `public`, fix it with `alter extension pg_trgm set schema public;` and repeat
the check. Smoke test **after step 9**, once the stack is up: signed in as the admin (aal2), open
the app's tag field, or call `GET /api/v1/tags?kind=skill&q=a`, and expect 200 with a list; then,
with a contributor link from step 8, `GET /api/v1/contribute/tags?q=a` with the
`X-Contributor-Token` header and expect 200 (the web page does this when a contributor types a
tag).

## 4. The `contributor_api` role

```sql
select rolname, rolcanlogin from pg_roles where rolname = 'contributor_api';
-- exactly one row, rolcanlogin = false (NOLOGIN)

select pg_has_role('postgres', 'contributor_api', 'MEMBER') as member,
       pg_has_role('postgres', 'contributor_api', 'SET')    as can_set;
-- both true. PG 16 and later split membership from the right to `set role`.
```

The API connects as the login role in `DATABASE_URL` (`postgres.<ref>` through the pooler, which is
the `postgres` role) and runs `set local role contributor_api`. If `can_set` is false, run
`grant contributor_api to postgres with set true;`.

No other role may be able to become it:

```sql
select r as role, pg_has_role(r, 'contributor_api', 'MEMBER') as member
from unnest(array['anon', 'authenticated', 'service_role', 'authenticator']) as r;
-- all four rows: member = false
```

Smoke a contributor submission end to end **after step 9**: create a link (step 8 gives you the
admin), open `https://<site>/c#<token>` in a private window, submit a person, and confirm that the
person shows up in the admin's lists.

## 5. SECURITY DEFINER functions bypass RLS on hosted

The contributor functions and the sign-in token hook read tables the caller cannot. That works only
if the function owner bypasses RLS (the `postgres` role does, being the table owner with
`bypassrls`):

```sql
select p.proname, pg_get_userbyid(p.proowner) as owner, r.rolbypassrls
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
join pg_roles r on r.oid = p.proowner
where p.prosecdef;
-- every owner is `postgres`, rolbypassrls = true
```

The end-to-end proof is the pair of checks that need a running stack: the contributor submission of
step 4, and a successful admin sign-in whose access token carries `network_id`, `member_role` and
`person_id` (step 7). Either failing means the owner does not bypass RLS.

## 6. Revoke the excess default privileges from `authenticated`

The migrations grant `select, insert, update, delete` only, but hosted Supabase's default
privileges give `authenticated` ALL on new tables, including `TRUNCATE`, which ignores RLS and
would empty a table for any signed-in user.

```sql
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('authenticated', 'anon', 'service_role')
  and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')
order by 1, 2, 3;
```

For every `authenticated` row it returns:

```sql
revoke truncate, references, trigger on
  public.network, public.member, public.person, public.tag, public.person_skill,
  public.person_industry, public.social_link, public.contact_value, public.connection,
  public.contributor_link, public.duplicate_dismissal
  from authenticated;
```

Rerun the query: no `authenticated` or `anon` rows remain. (`service_role` is never used on a
request path, so its grants are not what protects the data.) Tables added by a later migration
inherit the hosted defaults again, so rerun this check after every migration that adds a table.

## 7. Supabase Auth settings (dashboard)

Authentication in the project dashboard:

- Sign In / Providers, Email: **turn off "Allow new users to sign up"** (the app has no
  self-registration; users are created by the owner).
- Multi-Factor: **TOTP enabled** (enrol and verify).
- Policies: **minimum password length 12 or more**; **"Secure password change" on**.
- Hooks, Customize Access Token (JWT) Claims: enable it and choose the Postgres function
  **`public.custom_access_token_hook`**.

Verify: sign-up through `POST https://<ref>.supabase.co/auth/v1/signup` is refused; after step 8 the
admin's access token (decode it at jwt.io or with `cut -d. -f2 | base64 -d`) has `network_id`,
`member_role` and `person_id`, and `aal: aal2` once TOTP is verified. A token without
`network_id` means the hook is not registered: the app then looks empty rather than broken.

## 8. Create the admin and bootstrap the network

1. Dashboard, Authentication, Users, **Add user**: the admin's email and a password of 12 or more
   characters (auto-confirm).
2. Bootstrap the network from the repository root, against the **session pooler** with the owner's
   connection string (the script bypasses RLS on purpose; it needs the database owner):

   ```bash
   DATABASE_URL="$SESSION_URL" uv run --project apps/api python apps/api/scripts/bootstrap_admin.py \
       --email admin@example.com --name-ar "الاسم" --name-latin "Name"
   ```

   Run it once. It is idempotent: a second run prints "already bootstrapped" and exits 0.
3. Sign in to the deployed site as the admin and **enrol TOTP** when asked (QR code, then the
   6-digit code). Admin pages and endpoints need `aal2`.

Verify: the admin lands on the search page after the TOTP step, and the lists load (not an empty,
silent page).

## 9. Container environment

Set these on the containers in the bunny.net app (never in the repository or in the images):

| Container | Variable | Value |
| --- | --- | --- |
| `connections-api` | `DATABASE_URL` | `$TX_URL`: the **transaction pooler**, port 6543 |
| `connections-api` | `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `connections-api` | `SUPABASE_ANON_KEY` | the project's anon (publishable) key |
| `connections-api` | `SUPABASE_JWT_AUDIENCE` | `authenticated` |
| `connections-api` | `SUPABASE_JWT_ISSUER` | `https://<ref>.supabase.co/auth/v1` |
| `connections-api` | `API_ENV` | `production` |
| `connections-api` | `API_CORS_ORIGINS` | the site's public origin, e.g. `https://connections.example.com` |
| `connections-api` | `WEB_PUBLIC_URL` | the same public origin (contributor links are built from it) |
| `connections-web` | `SUPABASE_URL` | `https://<ref>.supabase.co`: a bare origin, no path and no trailing slash |
| `connections-web` | `SUPABASE_ANON_KEY` | the same anon key |
| `connections-web` | `BACKEND_HOST` | `localhost` (both containers share one network in the app) |

Do not set `SUPABASE_JWT_SECRET` (hosted tokens are verified against the project's published signing
keys, and any HS256 token is refused), and leave `FORWARDED_ALLOW_IPS` unset (the image default,
`127.0.0.1`, is Nginx in the same app). Never set it to `*`.

Verify: both containers are healthy in the dashboard. A web container that restarts in a loop
prints the reason (`SUPABASE_URL must be a bare origin` and similar); an API container that restarts
prints which setting is missing. Then run the workflow once more (or restart) so the new settings
apply.

The smoke tests of steps 3 and 4 run now.

## 10. After the deploy: check the response headers and the logs

```bash
SITE=https://connections.example.com
curl -sI "$SITE/"
```

Expect all of these on the response:

- `Content-Security-Policy:` with `script-src 'self'`, `connect-src 'self' https://<ref>.supabase.co`,
  `frame-ancestors 'none'`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cache-Control: no-store`

The no-store files:

```bash
for p in /index.html /ngsw-worker.js /ngsw.json /runtime-config.json /assets/i18n/ar.json; do
  printf '%s  ' "$p"; curl -sI "$SITE$p" | grep -i '^cache-control'
done
curl -s "$SITE/runtime-config.json"   # your project URL and anon key, nothing else
```

Every line must say `no-store`. If bunny.net's CDN sits in front of the app, a stale cached copy of
any of these means the CDN ignores the origin's header; fix that in the pull-zone cache settings
before going on.

Logs (bunny.net dashboard, container logs). Make a request that carries a query string, then
read both containers' logs:

```bash
curl -s -o /dev/null "$SITE/api/v1/health?x=querycheck"
```

- Nginx (`connections-web`): the line is `GET /api/v1/health 200`.
- uvicorn (`connections-api`): the JSON line's message is `GET /api/v1/health 200`.

Neither may contain `querycheck`, a client address, or any contributor token. Also check that the
API sees the real client address: the per-IP limit is only as good as it. Make 70 requests to a
contributor endpoint from one machine (`/api/v1/contribute/tags?q=a`, a different made-up
`X-Contributor-Token` each time, so the per-link budget of 30 a minute is not what trips); the 61st
to the 70th must answer 429, and an unrelated machine must still get through. If every visitor shares
one budget, bunny.net's edge address is what Nginx forwards, and Nginx needs `set_real_ip_from`
for the edge ranges (`nginx.conf`).

Last, the product smoke: sign in as the admin with TOTP, add a person, create a contributor link,
use it in a private window.
