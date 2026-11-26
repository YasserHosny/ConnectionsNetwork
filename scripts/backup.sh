#!/usr/bin/env bash
# The steps of .github/workflows/backup.yml, kept in a script so they can be shellchecked and
# run against a local database and a fake storage endpoint (docs/operations/backup-restore.md).
#
#   scripts/backup.sh backup      pg_dump | age -> $RUNNER_TEMP, upload to bunny.net Storage, verify
#   scripts/backup.sh retention   delete backups older than 30 days from the storage zone
#   scripts/backup.sh keepalive   hit the API's database check (must be 2xx) and Supabase REST (any
#                                 HTTP answer), so the project does not pause after 7 days without
#                                 activity (Free plan)
#
# Everything comes from the environment and nothing is echoed. The repository is public, and so
# are its Actions logs: GitHub masks a secret only as the whole string, so a host or user name
# that a tool prints out of a secret URL would be readable by anyone. pg_dump's messages are
# therefore redacted before they are printed, and the Supabase check prints curl's exit code, not
# its message. The dump is streamed straight into age: no plaintext copy of the data is ever
# written to disk. Only the age PUBLIC key is here; the private key stays offline with the owner.
#
#   backup:     DATABASE_URL_SESSION  session pooler URL (port 5432), not the transaction pooler
#               BACKUP_AGE_RECIPIENT  age public key (age1...)
#   backup and retention:
#               BUNNY_STORAGE_ZONE, BUNNY_STORAGE_HOST (region endpoint, e.g. storage.bunnycdn.com),
#               BUNNY_STORAGE_KEY (the storage zone's password)
#   keepalive:  WEB_PUBLIC_URL, SUPABASE_URL, SUPABASE_ANON_KEY
#   optional:   RUNNER_TEMP (where the encrypted file is written; defaults to $TMPDIR or /tmp)
#               BUNNY_STORAGE_SCHEME (default https; only a local test points it at http)
set -euo pipefail

BACKUP_FOLDER="backups"
RETENTION_DAYS=30
PG_MAJOR=17
# Our own file names. Retention only ever touches objects that match, and reads their age from
# the UTC date in the name, so an unrelated object in the zone is never deleted.
NAME_PATTERN='^connections-(?<day>[0-9]{4}-[0-9]{2}-[0-9]{2})\.dump\.age$'

die() {
  echo "backup.sh: $*" >&2
  exit 1
}

require_env() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || die "$name is not set"
  done
}

# Prints pg_dump's messages (file $1) without what identifies the server: libpq quotes the host, user and
# database ("connection to server at "<host>" (<address>), port 5432 failed: ... for user
# "postgres.<ref>""), so every quoted string goes, and so do addresses, URLs and pooler-style
# names in case one is printed unquoted. What remains (the error's kind, the port) is enough to
# tell a wrong password from an unreachable host. If the session URL's own host or user still
# shows after that, nothing of the message is printed.
redact_pg_messages() {
  local url="$DATABASE_URL_SESSION" rest userinfo user host redacted
  rest="${url#*://}"
  rest="${rest%%[/?]*}"
  host="${rest##*@}"
  host="${host%:*}"
  user=""
  if [[ "$rest" == *@* ]]; then
    userinfo="${rest%@*}"
    user="${userinfo%%:*}"
  fi
  redacted="$(sed -E \
    -e 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]*#<url>#g' \
    -e 's/"[^"]*"/"<redacted>"/g' \
    -e 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/<address>/g' \
    -e 's/\([0-9A-Fa-f]*:[0-9A-Fa-f:]*:[0-9A-Fa-f:]*\)/(<address>)/g' \
    -e 's/[A-Za-z0-9.-]+\.supabase\.(com|co)/<host>/g' \
    -e 's/postgres\.[A-Za-z0-9]+/postgres.<ref>/g' \
    "$1" | sed -n '1,20p')"
  if { [ -n "$host" ] && [[ "$redacted" == *"$host"* ]]; } ||
    { [ -n "$user" ] && [[ "$redacted" == *"$user"* ]]; }; then
    redacted="(withheld: the messages still named the server or the user)"
  fi
  printf '%s\n' "$redacted"
}

storage_url() {
  printf '%s://%s/%s/%s' "${BUNNY_STORAGE_SCHEME:-https}" "$BUNNY_STORAGE_HOST" \
    "$BUNNY_STORAGE_ZONE" "$1"
}

# curl against the storage API. The key goes in through a config file descriptor rather than
# -H, so it is not on the command line (visible in `ps`), and curl never prints it.
bunny_curl() {
  curl --fail --silent --show-error --retry 3 --retry-delay 5 \
    --config <(printf 'header = "AccessKey: %s"\n' "$BUNNY_STORAGE_KEY") "$@"
}

# The objects in the backups folder, as the storage API's JSON array.
list_backups() {
  local listing
  listing="$(bunny_curl "$(storage_url "$BACKUP_FOLDER/")")"
  jq -e 'type == "array"' <<<"$listing" >/dev/null || die "unexpected storage listing"
  printf '%s' "$listing"
}

cmd_backup() {
  require_env DATABASE_URL_SESSION BACKUP_AGE_RECIPIENT \
    BUNNY_STORAGE_ZONE BUNNY_STORAGE_HOST BUNNY_STORAGE_KEY

  # A dump taken by an older client cannot be restored by a newer server, and pg_dump refuses to
  # dump a server newer than itself.
  local pg_version
  pg_version="$(pg_dump --version)"
  [[ "$pg_version" =~ [^0-9]${PG_MAJOR}\.[0-9]+ ]] || die "pg_dump is not version $PG_MAJOR ($pg_version)"

  local name
  name="connections-$(date -u +%F).dump.age"
  # Global, not local: the EXIT trap runs after this function has returned.
  out="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/$name"
  pg_err="$out.pg_dump-stderr"
  umask 077
  # Remove the encrypted file on every exit: it holds all contact data, even if only encrypted.
  trap 'rm -f -- "$out" "$pg_err"' EXIT

  # pg_dump's stderr goes to a file, never straight to the log (see redact_pg_messages). A
  # failure of either side fails the job, and nothing gets uploaded.
  local status
  set +e
  pg_dump --format=custom "$DATABASE_URL_SESSION" 2>"$pg_err" |
    age -r "$BACKUP_AGE_RECIPIENT" -o "$out"
  status=("${PIPESTATUS[@]}")
  set -e
  if [ -s "$pg_err" ]; then
    echo "backup.sh: pg_dump messages (server, user and addresses removed):" >&2
    redact_pg_messages "$pg_err" >&2
  fi
  # age first: when it fails, pg_dump dies of the closed pipe (141), which is not the cause.
  [ "${status[1]}" -eq 0 ] || die "age failed (exit ${status[1]})"
  [ "${status[0]}" -eq 0 ] || die "pg_dump failed (exit ${status[0]})"

  [ -s "$out" ] || die "encrypted dump is empty"
  [ "$(head -c 19 "$out")" = "age-encryption.org/" ] || die "output is not an age file"
  local size
  size="$(stat -c %s "$out")"

  bunny_curl --request PUT --upload-file "$out" "$(storage_url "$BACKUP_FOLDER/$name")" >/dev/null

  # Trust the listing, not the PUT: the object must be there, with the size we sent.
  list_backups | jq -e --arg name "$name" --argjson size "$size" \
    'any(.[]; .ObjectName == $name and .Length == $size)' >/dev/null \
    || die "uploaded object not found in the storage listing with the expected size"
  echo "backup uploaded: $BACKUP_FOLDER/$name ($size bytes)"
}

cmd_retention() {
  require_env BUNNY_STORAGE_ZONE BUNNY_STORAGE_HOST BUNNY_STORAGE_KEY

  local cutoff listing keep old name
  cutoff="$(date -u -d "$RETENTION_DAYS days ago" +%F)"
  listing="$(list_backups)"

  # Names of our backups dated before the cutoff, and how many dated on or after it.
  old="$(jq -r --arg cutoff "$cutoff" --arg pattern "$NAME_PATTERN" \
    '.[] | select(.IsDirectory | not) | .ObjectName
     | select(capture($pattern) | .day < $cutoff)' <<<"$listing")"
  keep="$(jq -r --arg cutoff "$cutoff" --arg pattern "$NAME_PATTERN" \
    '[.[] | select(.IsDirectory | not) | .ObjectName
      | select(capture($pattern) | .day >= $cutoff)] | length' <<<"$listing")"

  # Never delete the last copies: if nothing recent remains, something is wrong with the
  # nightly backup (or with this script), and the old ones are what is left.
  if [ -n "$old" ] && [ "$keep" -eq 0 ]; then
    die "no backup newer than $cutoff in the zone; refusing to delete the older ones"
  fi

  local deleted=0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    bunny_curl --request DELETE "$(storage_url "$BACKUP_FOLDER/$name")" >/dev/null
    deleted=$((deleted + 1))
  done <<<"$old"
  echo "retention: kept $keep, deleted $deleted (older than $cutoff)"
}

cmd_keepalive() {
  require_env WEB_PUBLIC_URL SUPABASE_URL SUPABASE_ANON_KEY

  # Through the public site: Nginx -> API -> `select 1` on the database (503 if it cannot).
  curl -fsS --max-time 30 --retry 3 --retry-delay 5 "${WEB_PUBLIC_URL%/}/api/v1/health/db"
  echo
  # Straight to Supabase, so activity is recorded even if the API path is down. Any HTTP answer
  # counts: a project that refuses the anon key on this root path (401/403) still saw the request,
  # and the call above is the real keepalive. Only a network error or a 5xx fails here.
  # -s without -S: curl's own message would name <ref>.supabase.co, and only the whole
  # SUPABASE_URL is masked. Its exit code says enough (6 no DNS, 7 no connection, 28 timeout).
  local code rc=0
  code="$(curl -s --max-time 30 --retry 3 --retry-delay 5 -o /dev/null -w '%{http_code}' \
    --config <(printf 'header = "apikey: %s"\n' "$SUPABASE_ANON_KEY") \
    "${SUPABASE_URL%/}/rest/v1/")" || rc=$?
  echo "supabase rest answered HTTP $code (curl exit $rc)"
  [ "$rc" -eq 0 ] && [[ "$code" =~ ^[1-4][0-9][0-9]$ ]] ||
    die "supabase rest check failed (HTTP $code, curl exit $rc)"
  echo "keepalive ok"
}

case "${1:-}" in
  backup) cmd_backup ;;
  retention) cmd_retention ;;
  keepalive) cmd_keepalive ;;
  *)
    echo "usage: ${0##*/} backup|retention|keepalive" >&2
    exit 2
    ;;
esac
