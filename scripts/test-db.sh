#!/usr/bin/env bash
# (Re)start a throwaway Postgres 17 for the database-backed tests and prepare its schema:
# the Supabase stand-ins first, then every supabase/migrations/*.sql in filename order.
#
#   pnpm db:test
#   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54329/postgres pnpm test:api
#
# psql is not required on the host: everything runs through `docker exec` into the container.
set -euo pipefail

# Glob expansion order follows the locale; migrations must apply in plain filename order.
export LC_ALL=C

NAME=connections-test-db
PORT=54329
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

psql_in_container() {
  docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"
}

docker rm -f "$NAME" >/dev/null 2>&1 || true
# Published on the loopback interface only: the database has a well-known password.
docker run -d --name "$NAME" \
  -e POSTGRES_PASSWORD=postgres \
  -p "127.0.0.1:$PORT:5432" \
  postgres:17 >/dev/null

# The image first runs a temporary server on a unix socket only, then restarts. Checking over
# TCP succeeds only for the final server, so the stand-ins never hit the temporary one.
echo "waiting for postgres on port $PORT"
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null

echo "applying supabase/tests/standins.sql"
psql_in_container <"$ROOT/supabase/tests/standins.sql"

shopt -s nullglob
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "applying supabase/migrations/$(basename "$f")"
  psql_in_container <"$f"
done

echo "ready: postgresql://postgres:postgres@localhost:$PORT/postgres"
