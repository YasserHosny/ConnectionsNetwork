# Assistant Gateway: owner setup and operations

The one-time setup for the Assistant Gateway (`apps/assistant-gateway/`), plus the two things you
do afterwards: change a cap or a model, and read spend. Nothing here is automated. The gateway is
the third container of the Connections bunny.net app (spec sections 6.3 and 6.6), next to
`connections-api` and `connections-web`. Do steps 1 to 5 **before the first merge to `main` that
deploys it**: `deploy.yml` updates a container named `assistant-gateway` last, and fails there if
the container does not exist yet (the api and web updates before it still go through).

Placeholders: `<ref>` is the Supabase project reference, `<owner>` the GitHub account or
organisation (lower case), `<pooler host>` the host the dashboard's **Connect** dialog shows for
the pooler (copy it, do not guess it).

The gateway refuses to start, with a log line naming the cause, when its configuration is invalid
(a bad `config/*.yaml`, or a missing or malformed key-hash variable), or when a migration is
pending.

## 1. Create the database role and schema

The gateway owns one schema, `assistant_gateway`, and nothing else. In the Supabase **SQL editor**
of the hosted project, run:

```sql
create role assistant_gateway login password '<a long generated password>';
create schema assistant_gateway authorization assistant_gateway;
```

Keep the password in your password manager; it goes only into the container's `AG_DATABASE_URL`
(step 5). The role is not a superuser and does not bypass row-level security. The ledger does not
use any Supabase table, so it needs no other grant.

`AG_DATABASE_URL` is the **transaction pooler** URL (port 6543), as that role. The role goes in
the user name, like `connections_api` in the deploy checklist, step 4:

```
postgresql://assistant_gateway.<ref>:<password>@<pooler host>:6543/postgres
```

## 2. Run the migrations

They are run by hand, like the API's migrations, and again after any release that adds a file to
`apps/assistant-gateway/migrations/`. From any machine with Docker (a published image has to
exist: run **Actions, Deploy** once from `main` first, or build the image locally):

```bash
docker run --rm -e AG_DATABASE_URL='postgresql://assistant_gateway.<ref>:<password>@<pooler host>:6543/postgres' \
  ghcr.io/<owner>/assistant-gateway python -m assistant_gateway.migrate
```

Only `AG_DATABASE_URL` is needed. It prints `applied: 0001_ledger` the first time and
`no pending migrations` afterwards. Each file runs in its own transaction and is recorded in
`assistant_gateway.schema_migrations`, so a failure leaves the earlier files applied and the
failing one not. If you skip this after a release, the new container refuses to start and its log
names the pending version.

## 3. Make an app key

For each app that calls the gateway. `config/production.yaml` lists one, `connections`; the model
trial's `connections-trial` exists only in `config/local.yaml`, with its own hash variable
`AG_TRIAL_KEY_HASH`:

```bash
python -c "import secrets;print(secrets.token_urlsafe(48))"
```

The output is the **key**. Compute its **sha256**:

```bash
printf '%s' '<the key>' | sha256sum | cut -d' ' -f1
```

- The 64-character hash goes in `AG_CONNECTIONS_KEY_HASH` on the gateway container. The name is
  the app's `key_hash_env` value in `config/production.yaml`.
- The key itself goes in the Connections API's environment (plan 3 wires it). It is never stored
  in the gateway, in the repository or in a log.

Rotating a key is the same steps with a new key: change the hash on the gateway container, then
the key in the caller, and restart both.

## 4. Anthropic Console: a dedicated workspace and a spend limit

This is the backstop outside the code (spec 6.3). If a bug in the ledger let spending run away, the
provider would still stop it.

1. In the Anthropic Console, create a **workspace** only for the gateway.
2. Create the gateway's API key **inside that workspace**. It is `ANTHROPIC_API_KEY` in step 5.
3. Set the workspace's **monthly spend limit just above the sum of the app caps** (the
   `budget.monthly_cap_usd` values in `config/production.yaml`). Not far above: the limit is the
   most a ledger bug can cost.
4. Do the same for the speech provider's key (`OPENAI_API_KEY`) wherever that provider supports a
   spend limit.

Raise the Console limit whenever you raise a cap (step 6), in the same sitting.

## 5. Create the bunny.net container

In the Connections Magic Containers app (the one with `connections-api` and `connections-web`),
add a third container:

- **Name:** `assistant-gateway`, exactly: it must match `BUNNY_GATEWAY_CONTAINER` in
  `.github/workflows/deploy.yml`.
- **Image:** `ghcr.io/<owner>/assistant-gateway`, tag `latest`. Use the same GHCR pull registry as
  the other two if the package is private.
- **Port:** 8100.
- **Delete the public endpoint bunny.net adds for port 8100.** Like port 8000, it is added on its
  own when the container is created: open the container's endpoints and delete it. The gateway is
  reached only from `connections-api` on `localhost:8100`; the app's only endpoint stays the web
  container's CDN endpoint on port 80.
- **Environment variables:**

  | Variable | Value |
  |---|---|
  | `AG_ENV` | `production` |
  | `AG_DATABASE_URL` | the URL from step 1 |
  | `AG_CONNECTIONS_KEY_HASH` | the hash from step 3 |
  | `ANTHROPIC_API_KEY` | the key from step 4 |
  | `OPENAI_API_KEY` | the speech provider's key, once server transcription is used |

  Every app in `config/production.yaml` needs its `key_hash_env` variable, or the container
  refuses to start. `AG_CONFIG_PATH` is baked into the image as `/app/config/production.yaml`; do not set it.
- The app stays at **minimum 1, maximum 1** instance (deploy checklist, step 1 item 3): the
  gateway's rate limits are kept in memory, like the API's.

Check: the container turns healthy (its health check is `GET /healthz` on 8100). From a shell in
the API container, `python -c "import urllib.request as u;print(u.urlopen('http://127.0.0.1:8100/healthz').read())"`
answers `{"status": ...}`. From outside the app, the gateway must not answer at all.

## 6. Changing a cap or a model

Caps, models, effort and prices live in `apps/assistant-gateway/config/production.yaml`. Edit it,
open a PR, merge, and let the deploy run: the config is copied into the image, so a change takes
effect when the new container starts. There is no admin API and no database setting.

- A model named under a use case must have an entry under `pricing`; otherwise the container
  refuses to start. Check a provider's current price before adding one.
- After raising a monthly cap, raise the Console workspace limit (step 4).

## 7. Reading spend

Each app reads its own month, with its own key. Run it from the API container's shell, where the
gateway is on localhost and the key is in the environment. The API image has no `curl`; use Python:

```bash
python - <<'PY'
import os, urllib.request
req = urllib.request.Request(
    "http://127.0.0.1:8100/v1/usage?period=2026-11",
    headers={"Authorization": "Bearer " + os.environ["<the variable that holds the key>"]},
)
print(urllib.request.urlopen(req).read().decode())
PY
```

or, where `curl` exists: `curl -H "Authorization: Bearer $KEY" localhost:8100/v1/usage?period=YYYY-MM`.

The answer has the month's settled and reserved dollars, by use case and by end user. Reservations
still open after 15 minutes count at their reserved amount (spec 6.3), so the total can be a little
above what the provider billed, never below.
