# First deploy checklist (owner-run)

The one-time setup that connects the repository to hosted Supabase, GitHub Container Registry
(GHCR) and bunny.net Magic Containers. Nothing here is automated, and none of it was done by the
agent that wrote this file. After it, every push to `main` redeploys through
`.github/workflows/deploy.yml`.

Work top to bottom. Each step ends with how to check it. Steps 2, 4 and 5 end with smoke tests that
need a running stack; those are run after step 9 (marked below).

Placeholders: `<ref>` is the Supabase project reference, `<owner>` the GitHub account or
organisation (lower case), `$SESSION_URL` the **session pooler** connection string (port 5432,
user `postgres.<ref>`), used for migrations and the bootstrap only. The API uses the **transaction pooler** (port 6543) as `connections_api` (step 4).
`<pooler host>` is the host the dashboard's **Connect** dialog shows for the pooler; copy it, do not
guess it: it varies by project (the first deploy's was `aws-1-eu-west-1.pooler.supabase.com`, not
`aws-0-...`).

## 1. GHCR, GitHub secrets and the bunny.net app

The images are `ghcr.io/<owner>/connections-api` and `ghcr.io/<owner>/connections-web`, tagged
`latest` and with the commit SHA. The container names `deploy.yml` updates are `connections-api`
and `connections-web` (the `BUNNY_API_CONTAINER` / `BUNNY_WEB_CONTAINER` values at the top of the
workflow); the containers must be created with exactly these names.

1. GitHub Environment `production`, created **before the first run** (a run that names a missing
   environment creates it with no branch rule): Settings, Environments, New environment.
   `deploy.yml`'s job runs in it, and only from `main` (`if: github.ref == 'refs/heads/main'`),
   because a manually started run can otherwise be pointed at any branch by anyone with write
   access, and would push `latest` and use the bunny.net key.
   - Deployment branches and tags: **Selected branches and tags**, add the rule `main`.
   - Environment secrets (not repository secrets, so no other workflow or branch can read them):
     `BUNNY_API_KEY` (bunny.net account API key) and `BUNNY_APP_ID` (the app's id). The app id
     exists only after item 3, so add that secret then.
   - Optionally add yourself as a required reviewer. This is for `production` only: the nightly
     backup workflow has its own `backup` environment (backup-restore.md), which must **never**
     have required reviewers, or a scheduled run waits for an approval that never comes and no
     backup is taken.

   `GITHUB_TOKEN` is provided by Actions.
2. The images do not exist until the workflow has run once. Run **Actions, Deploy, Run workflow**
   **from `main`** (the branch selector in the dialog). It builds and pushes both images, then its
   deploy steps fail because the app and containers are not there yet (and `BUNNY_APP_ID` is not
   set). That first failure is expected.
3. In bunny.net create **one Magic Containers app** with **two containers** in it, `connections-api`
   (port 8000) and `connections-web` (port 80), pulling the two images above. Only the web
   container's port 80 may be published as the app's endpoint. **Never publish port 8000**: the API is
   reached only through Nginx, and uvicorn trusts forwarded headers from localhost. **The bunny.net
   form adds a public endpoint for port 8000 on its own** when the API container is created: open
   the API container's endpoints and delete it, so the app's only endpoint is the web container's
   CDN endpoint on port 80. Then add
   `BUNNY_APP_ID` to the `production` environment's secrets and run the workflow again, from `main`.

   Scaling: set the app to **minimum 1, maximum 1** instance. The rate limits (SlowAPI) are kept in
   the API's memory, so a second instance would double every limit and split the counts.
4. Registry: if the GHCR packages are private, add a GHCR pull registry in bunny.net (a GitHub
   token with `read:packages`) and select it for both containers (needed already when creating
   them in item 3). Alternatively make both packages public.
5. Custom domain: in your DNS provider, a **CNAME** from the site's name (e.g. `connections`) to the
   app's CDN address, **`mc-<id>.b-cdn.net`**. Not the `mc-<id>.bunny.run` name, which bunny.net
   also shows: its custom-hostname check accepts only the `b-cdn.net` target. Once public DNS
   returns the `b-cdn.net` name, add the hostname in bunny.net and press **Verify & Activate SSL**
   (Let's Encrypt).

Verify: the second workflow run is green, and the bunny.net dashboard shows both containers on the
commit SHA tag, one instance, and a single endpoint (port 80). `https://<site>/api/v1/health`
answers 200 over the custom domain. Also check the guard: starting the workflow from any other branch shows the deploy job as
skipped.

## 2. Hosted Supabase: pg_trgm, then the migrations

The Free plan allows **two active free projects per owner, counted across all organisations**: a
new organisation does not help. If you are at the limit, pause another project first (its data is
kept) or upgrade.

The SQL in this and the following steps runs in the Supabase SQL editor, or through
`psql "$SESSION_URL"`.

**Before the migrations**, check where `pg_trgm` lives. The tag autocomplete calls
`public.similarity(...)` and an index uses `gin_trgm_ops`; hosted Supabase likes to install
extensions into the `extensions` schema, where `public.similarity` does not exist.

```sql
select e.extname, n.nspname as schema
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'pg_trgm';
```

- No row: fine, the first migration installs it into `public`.
- `public`: fine.
- Any other schema: `alter extension pg_trgm set schema public;` and check again. (The first
  migration refuses to run while pg_trgm sits elsewhere, with this same hint.)

Then, from the repository root, with the Supabase CLI, against the **session pooler**:

```bash
supabase migration up --db-url "$SESSION_URL"
```

Never run migrations from the deploy workflow and never through the transaction pooler (it does not
keep session state). Verify: `supabase migration list --db-url "$SESSION_URL"` shows all nine
migrations (`20261119000001` to `20261119000009`) as applied, locally and remotely, and:

```sql
select public.similarity('ahmed', 'ahmad');   -- a number, not an error
```

Smoke test **after step 9**, once the stack is up: signed in as the admin (aal2), open the app's tag
field, or call `GET /api/v1/tags?kind=skill&q=a`, and expect 200 with a list; then, with a
contributor link from step 8, `GET /api/v1/contribute/tags?kind=skill&q=a` with the
`X-Contributor-Token` header and expect 200 (`kind` is required: without it the answer is 422) (the
web page does this when a contributor types a tag).

## 3. Turn off the Data API and GraphQL

Nothing in this project uses Supabase's Data API (PostgREST) or GraphQL: the web app talks to
Supabase for sign-in only, and the API connects to Postgres itself. Left on, they serve every table
in `public` to anyone holding the anon key (it ships in the web app) plus a session, past the API's
checks and rate limits. RLS still holds there (the admin policies require `aal2` in the token), but
it must not be the only wall.

1. Project Settings, **Data API**: turn the Data API **off**. If the dashboard only offers the
   exposed-schema list, remove **`public`** (and `graphql_public`) from **Exposed schemas** and save.
2. Database, Extensions: **disable `pg_graphql`** (`drop extension if exists pg_graphql;` does the
   same).

Verify, with the anon key:

```bash
ANON=<the project's anon key>
curl -s -o /dev/null -w '%{http_code}\n' -H "apikey: $ANON" "https://<ref>.supabase.co/rest/v1/person?select=id"
curl -s -H "apikey: $ANON" -H 'content-type: application/json' \
  -d '{"query":"{ __typename }"}' "https://<ref>.supabase.co/graphql/v1"
```

The first must not be `200` (a disabled Data API answers 404, or an error naming the exposed schemas);
the second must not return `{"data":...}`. A `200` with `[]` from the first means `public` is still
exposed: RLS hid the rows, but the table is reachable.

## 4. The API's database login: `connections_api`

The API never connects as `postgres`: the owner bypasses row-level security, so one query that
escaped the API's per-request transaction would read everything. Migration `20261119000009` creates
`connections_api`: NOLOGIN, no privileges of its own, allowed only to `set role authenticated`
(admin requests, under RLS) and `set role contributor_api` (contributor links). `postgres` stays the
role for migrations, `bootstrap_admin.py` (step 8) and the nightly backup.

Give it a login with a generated password (keep it in your password manager; it goes only into the
container environment of step 9):

```sql
alter role connections_api login password '<a long generated password>';
```

Verify:

```sql
select rolname, rolcanlogin, rolinherit, rolbypassrls, rolsuper
from pg_roles where rolname in ('connections_api', 'contributor_api');
-- connections_api: rolcanlogin true, rolinherit false, rolbypassrls false, rolsuper false
-- contributor_api: rolcanlogin false

select r as role,
       pg_has_role('connections_api', r, 'SET')   as can_set,
       pg_has_role('connections_api', r, 'USAGE') as inherits
from unnest(array['authenticated', 'contributor_api', 'anon', 'service_role', 'postgres']) as r;
-- authenticated and contributor_api: can_set true, inherits false; the other three: both false
```

If `can_set` is false for `authenticated` or `contributor_api`, run
`grant authenticated, contributor_api to connections_api with inherit false, set true;` (it is what
the migration does; it needs the `postgres` role). PG 16 and later split membership from the right
to `set role`.

No other role may be able to become `contributor_api`:

```sql
select r as role, pg_has_role(r, 'contributor_api', 'MEMBER') as member
from unnest(array['anon', 'authenticated', 'service_role', 'authenticator']) as r;
-- all four rows: member = false
```

The connection string for step 9 is the transaction pooler's, with the role in the user name:
`postgresql://connections_api.<ref>:<password>@<pooler host>:6543/postgres`. Check it once from a
machine with `psql`:

```bash
psql "postgresql://connections_api.<ref>:<password>@<pooler host>:6543/postgres" \
  -c 'select 1' -c 'select count(*) from public.person'
# select 1 answers 1; the count is refused: permission denied for table person
```

Smoke a contributor submission end to end **after step 9**: create a link (step 8 gives you the
admin), open `https://<site>/c#<token>` in a private window, submit a person, and confirm that the
person shows up in the admin's lists. Together with the admin's lists loading, that proves the API
works under `connections_api` (both role switches).

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

## 6. Verify: no excess privileges for `anon` and `authenticated`

Hosted Supabase's default privileges give `anon` and `authenticated` ALL on new tables, `TRUNCATE`
included (it ignores RLS and would empty a table for any signed-in user), and EXECUTE on new
functions. The migrations take that back (`20261119000003_rls.sql`, `revoke` and
`alter default privileges`); this step only checks it.

```sql
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('authenticated', 'anon')
  and privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
union all
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon';
-- no rows

select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated
from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
where p.proname in ('custom_access_token_hook', 'contribute_person', 'contributor_link_info',
                    'contributor_tag_suggest', 'merge_persons', 'upsert_tag');
-- anon false everywhere; authenticated true only for merge_persons and upsert_tag
```

Any row in the first query means a migration did not apply as written: stop and find out why before
going on. (`service_role` is never used on a request path, so its grants are not what protects the
data.)

## 7. Supabase Auth settings (dashboard)

Authentication in the project dashboard:

- Sign In / Providers, Email: **turn off "Allow new users to sign up"** (the app has no
  self-registration; users are created by the owner).
- Multi-Factor: **TOTP enabled** (enrol and verify).
- Policies: **minimum password length 12 or more**; **"Secure password change" on**.
- Hooks, Customize Access Token (JWT) Claims: enable it and choose the Postgres function
  **`public.custom_access_token_hook`**.
- URL Configuration: **Site URL** = the site's public origin (e.g.
  `https://connections.example.com`), and **Redirect URLs** = that origin only (remove
  `localhost` entries). Password-reset and invite emails link there; any other origin would receive
  the one-time token.

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
| `connections-api` | `DATABASE_URL` | the **transaction pooler** (port 6543) as `connections_api` (step 4): `postgresql://connections_api.<ref>:<password>@<pooler host>:6543/postgres`. Never `postgres` |
| `connections-api` | `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `connections-api` | `SUPABASE_ANON_KEY` | the project's **publishable** key (`sb_publishable_...`, Project Settings, API Keys); the legacy `anon` JWT also works, but Supabase is retiring those. Never a secret or `service_role` key |
| `connections-api` | `SUPABASE_JWT_AUDIENCE` | `authenticated` |
| `connections-api` | `SUPABASE_JWT_ISSUER` | `https://<ref>.supabase.co/auth/v1` |
| `connections-api` | `API_ENV` | `production` |
| `connections-api` | `API_CORS_ORIGINS` | the site's public origin, e.g. `https://connections.example.com` |
| `connections-api` | `WEB_PUBLIC_URL` | the same public origin (contributor links are built from it) |
| `connections-web` | `SUPABASE_URL` | `https://<ref>.supabase.co`: a bare origin, no path and no trailing slash |
| `connections-web` | `SUPABASE_ANON_KEY` | the same publishable key |
| `connections-web` | `BACKEND_HOST` | `127.0.0.1` (the image default, so it may be left unset): both containers share one network in the app. Not `localhost`, which can resolve to `::1`, where uvicorn does not listen |

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
for p in /index.html /ngsw-worker.js /ngsw.json /runtime-config.json /assets/i18n/ar.json /api/v1/health; do
  printf '%s  ' "$p"; curl -sI "$SITE$p" | grep -i '^cache-control'
done
curl -s "$SITE/runtime-config.json"   # your project URL and anon key, nothing else
```

Every line must say `no-store` or `no-cache`, exactly once, and the API line must say `no-store`
(`/api/v1/health` stands for every API response: they carry contact data).

bunny.net's CDN sits in front of the app (the Magic Containers endpoint is a pull zone). With the
server cache set to respect the origin's `Cache-Control`, it never shares a cached copy between
visitors, but it rewrites the header browsers receive to `no-cache`, and that pull zone's
browser-cache setting is locked in the dashboard. `no-cache` is acceptable for the static files
(the browser re-checks them every time); it is **not** for API responses, which must not be written
to the browser's disk. Add an edge rule on the pull zone:

- Action **Set Response Header**, `Cache-Control` = `no-store`;
- Condition **Request URL** matches `*/api/*`.

It applies within a minute; then the loop above shows `no-store` once on `/api/v1/health`.

Logs (bunny.net dashboard, container logs). Make a request that carries a query string, then
read both containers' logs:

```bash
curl -s -o /dev/null "$SITE/api/v1/health?x=querycheck"
```

- Nginx (`connections-web`): the line is `GET /api/v1/health 200`.
- uvicorn (`connections-api`): the JSON line's message is `GET /api/v1/health 200`.

Neither may contain `querycheck`, a client address, or any contributor token.

bunny.net keeps its own request logs at the edge (the pull zone or the Magic Containers endpoint in
front of the app), and those record the full URL, query string included (search text and tag
queries travel there). In the bunny.net dashboard, for every pull zone or endpoint in front of the
app: **turn logging off**, or, if you keep it, turn on log anonymisation and make sure query strings
are not logged. Check with the `querycheck` request above: it must not appear in the edge log
either. Also check that the
API sees the real client address: the per-IP limit is only as good as it. Make 70 requests to a
contributor endpoint from one machine (`/api/v1/contribute/tags?kind=skill&q=a`, a different made-up
`X-Contributor-Token` each time, so the per-link budget of 30 a minute is not what trips); the 61st
to the 70th must answer 429, and an unrelated machine must still get through. If every visitor shares
one budget, bunny.net's edge address is what Nginx forwards, and Nginx needs `set_real_ip_from`
for the edge ranges (`nginx.conf`).

Last, the product smoke: sign in as the admin with TOTP, add a person, create a contributor link,
use it in a private window. (Do not send a link to anyone else yet: step 11 comes first.)

## 11. Before sending the first contributor link: back up and run the restore drill

The Free plan has no backups. Set up the nightly encrypted backup and **run the restore drill before
the first contributor link is sent** (spec section 10): `docs/operations/backup-restore.md`, sections
1 and 2. Fill in the first row of its drill log; the row is the evidence that a backup can be read
and restored with equal `person`, `connection` and `contact_value` counts. Its secrets go in a
separate `backup` GitHub Environment, never one with required reviewers. The same job's keepalive
stops the project pausing after 7 days without activity.
