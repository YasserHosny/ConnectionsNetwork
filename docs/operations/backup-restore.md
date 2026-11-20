# Backups and the restore drill (owner-run)

The Supabase Free plan has no backups, and it pauses a project after 7 days without activity.
`.github/workflows/backup.yml` covers both. Every night at 01:00 UTC it:

1. runs `pg_dump --format=custom` against the **session pooler** (port 5432), streamed straight
   into `age`, so no plaintext copy of the data is written to disk;
2. uploads the encrypted file to bunny.net Storage as `backups/connections-<UTC date>.dump.age`
   and checks the object is listed with the size it sent;
3. deletes our `connections-<date>.dump.age` objects dated more than 30 days ago (it never
   touches other objects, and refuses to delete anything if no recent backup is in the zone);
4. calls `GET $WEB_PUBLIC_URL/api/v1/health/db` (Nginx, API, `select 1` on the database) and
   `GET $SUPABASE_URL/rest/v1/`, so the project is not paused. This step runs even when the backup
   failed.

The steps are in `scripts/backup.sh`; the workflow installs `postgresql-client-17`, `age` and `jq`
and calls it. The file holds every contact value, so it is encrypted **before it leaves the
runner**. Only the age *public* key is stored in GitHub; the private key never is.

**Before the first contributor link is sent: do steps 1 to 3 below, and fill in the first row of
the drill log.** Spec section 10 requires a restore tried once before then.

## 1. One-time setup

### Make the age key pair

On your own machine (install `age`: `apt install age`, `brew install age`):

```bash
age-keygen -o connections-backup.key
# Public key: age1xxxxxxxx...   <- printed on screen (and in a comment inside the file)
```

- **The private key is the file `connections-backup.key`.** Keep it offline and with the owner
  only: two copies, for example in a password manager's secure note and on a USB stick in a drawer.
  Never put it in the repository, in GitHub (secrets or variables), in bunny.net, in chat or in
  email. Without it every backup is unreadable; anyone who has it plus a backup can read all contact
  details.
- The line starting `age1` is the **public key**. It is not secret.

### Create the bunny.net Storage zone

A storage zone used for nothing else, with no pull zone (CDN) attached. Note its name, its region
endpoint and its password (Storage, the zone, FTP & API Access).

### GitHub secrets

In the `production` GitHub Environment (Settings, Environments, `production`; the same one
`deploy.yml` uses; its deployment-branch rule limits it to `main`, and `backup.yml` runs from
`main` only):

| Secret | Value |
| --- | --- |
| `DATABASE_URL_SESSION` | the **session pooler** string, port 5432, user `postgres.<ref>` (`$SESSION_URL` of the deploy checklist) |
| `BACKUP_AGE_RECIPIENT` | the public key, `age1...` |
| `BUNNY_STORAGE_ZONE` | the storage zone's name |
| `BUNNY_STORAGE_HOST` | the zone's region endpoint, host only, for example `storage.bunnycdn.com` (Falkenstein) or `ny.storage.bunnycdn.com` |
| `BUNNY_STORAGE_KEY` | the zone's password (read and write) |
| `WEB_PUBLIC_URL` | the site's public origin, `https://connections.example.com`, no trailing slash |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | the project's anon (publishable) key |

### First run

Actions, **Backup**, Run workflow, branch `main`. Expect a green run with these log lines:
`pg_dump (PostgreSQL) 17.x`, `backup uploaded: backups/connections-<date>.dump.age (<n> bytes)`,
`retention: kept 1, deleted 0 ...`, `{"status":"ok"}` and `keepalive ok`. In bunny.net, Storage, the
zone, folder `backups/`: the `.dump.age` object is there.

Notes:

- GitHub emails the person who last edited the schedule when a scheduled run fails; keep those
  emails on. A red Backup run means there is no backup for that night.
- On a public repository GitHub switches scheduled workflows off after 60 days with no repository
  activity. Then the backups **and the keepalive** stop; re-enable it under Actions.
- If the keepalive's second call (`/rest/v1/`) is refused on your project (401 or 403), tell the
  maintainer: the call has to change to something the anon key may read. The API call before it
  already proves the database answers.

## 2. The restore drill

Do this on your own machine, in an empty scratch folder. Requirements: `age`, Docker, and either
the PostgreSQL 17 client tools or the `docker run ... postgres:17` forms below. The private key
file is needed.

### 2.1 Take a fresh backup and note production's counts

Run the Backup workflow by hand (Actions, Backup, Run workflow, `main`), then immediately note
production's counts, so no edits fall between the dump and the counts:

```bash
export SESSION_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres'
psql "$SESSION_URL" -At -c "
  select 'person', count(*) from person union all
  select 'connection', count(*) from connection union all
  select 'contact_value', count(*) from contact_value order by 1"
```

(`psql` is a read-only use here. Without it on the host: `docker run --rm postgres:17 psql "$SESSION_URL" -At -c "..."`.)
Write the three numbers in the drill log. If you restore an older nightly file instead, expect the
counts to differ by whatever changed since; the drill passes only on equal counts, so prefer the
fresh file.

### 2.2 Download and decrypt

```bash
export BUNNY_STORAGE_HOST=storage.bunnycdn.com BUNNY_STORAGE_ZONE=<zone> BUNNY_STORAGE_KEY=<password>
FILE=connections-<UTC date>.dump.age
curl -fsS -H "AccessKey: $BUNNY_STORAGE_KEY" -o "$FILE" \
  "https://$BUNNY_STORAGE_HOST/$BUNNY_STORAGE_ZONE/backups/$FILE"

age -d -i /path/to/connections-backup.key -o restore.dump "$FILE"
```

(Or download the object from the bunny.net dashboard.) `restore.dump` is **plaintext** contact
data: delete it at the end (2.5).

### 2.3 A fresh database

Either works; the restore command is the same.

**A. A throwaway Postgres 17** (this is the path that was exercised end to end while writing this
runbook). The dump references the Supabase roles, so create them first:

```bash
docker run -d --name restore-drill -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:54332:5432 postgres:17
# wait until: docker exec restore-drill pg_isready -h 127.0.0.1 -U postgres
docker exec restore-drill psql -U postgres \
  -c "create role anon nologin" -c "create role authenticated nologin" \
  -c "create role service_role nologin bypassrls" -c "create role supabase_auth_admin nologin" \
  -c "create database restore_drill"
export RESTORE_URL='postgresql://postgres:postgres@127.0.0.1:54332/restore_drill'
```

**B. The local Supabase stack** (`supabase start` from the repository root). A *new database* in
it, not its `postgres` database, so the stack's own `auth` and `storage` schemas are not touched
and its roles and extensions are already there:

```bash
supabase start
docker exec supabase_db_ConnectionsNetwork psql -U postgres -c "create database restore_drill"
export RESTORE_URL='postgresql://postgres:postgres@127.0.0.1:54322/restore_drill'
```

### 2.4 Restore and compare

```bash
pg_restore --no-owner --no-privileges --dbname="$RESTORE_URL" restore.dump
# no client on the host:
# docker run --rm --network host -v "$PWD:/work" postgres:17 \
#   pg_restore --no-owner --no-privileges --dbname="$RESTORE_URL" /work/restore.dump

psql "$RESTORE_URL" -At -c "
  select 'person', count(*) from person union all
  select 'connection', count(*) from connection union all
  select 'contact_value', count(*) from contact_value order by 1"
```

`pg_restore` should print nothing. A hosted dump also carries Supabase-managed schemas, so a
message about an extension or a role that the target does not have (outside the `public` schema's
tables, functions and policies) is expected on option A. A message about a `public` table, an
index or a constraint is not: stop, and do not send contributor links until it is understood.

The restored counts for `person`, `connection` and `contact_value` must **equal** production's
(2.1). Optional extra checks: `select count(*) from member` is at least 1, and
`select count(*) from public.contributor_link` matches production.

### 2.5 Clean up

```bash
shred -u restore.dump "$FILE" 2>/dev/null || rm -f restore.dump "$FILE"
docker rm -f restore-drill          # option A
# option B: docker exec supabase_db_ConnectionsNetwork psql -U postgres -c "drop database restore_drill"
```

Then add a row to the drill log below.

### Drill log

Repeat the drill after a migration that adds tables, and at least once a year. Date is the day the
drill was run (`YYYY-MM-DD`).

| Date | Backup file restored | Restored into | person (prod / restored) | connection (prod / restored) | contact_value (prod / restored) | Result | By |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |

## 3. When the private key is lost or exposed

- **Lost:** the existing backups cannot be read. Make a new pair (section 1), replace the
  `BACKUP_AGE_RECIPIENT` secret and run the workflow: tomorrow's backups use the new key.
- **Exposed:** treat every backup made so far as readable by someone else, and every contact value
  in it as exposed. Make a new pair, replace the secret, delete the old objects from the zone, and
  decide whether the people concerned must be told.

## 4. Checking the script and the workflow without secrets

Docker is enough; nothing here touches a real service:

```bash
docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck scripts/backup.sh
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest .github/workflows/backup.yml
```

`scripts/backup.sh` can be pointed at a local Postgres and a fake storage endpoint by setting
`BUNNY_STORAGE_SCHEME=http` and `BUNNY_STORAGE_HOST=127.0.0.1:<port>` (the scheme override exists
for that and nothing else). `pg_dump` must be version 17 (the script refuses otherwise).
