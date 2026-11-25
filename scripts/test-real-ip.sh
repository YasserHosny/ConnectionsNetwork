#!/usr/bin/env bash
# Which client address does the API see behind Nginx? The per-address rate limit on contributor
# endpoints (SlowAPI, keyed by request.client.host) is only as good as this answer.
#
# Runs the real web entrypoint and infra/nginx/nginx.conf in nginx:1.27-alpine, with a stand-in
# API in the same network namespace (as in the bunny.net app): uvicorn 0.34.0 started with the
# image's own flags (--proxy-headers --forwarded-allow-ips 127.0.0.1), answering with the
# request.client.host it sees. Requests carry the headers bunny.net's CDN sends an origin:
# X-Real-IP (the visitor) and X-Forwarded-For.
#
# Docker only. Usage: scripts/test-real-ip.sh   (exit 0 = all cases pass)
set -euo pipefail
cd "$(dirname "$0")/.."

NGINX=real-ip-nginx
API=real-ip-api
PORT=18080
cleanup() { docker rm -f "$NGINX" "$API" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$NGINX" -p "127.0.0.1:$PORT:80" \
  -e SUPABASE_URL=https://example.supabase.co -e SUPABASE_ANON_KEY=test-key \
  -v "$PWD/infra/nginx/nginx.conf:/etc/nginx/templates/default.conf.template:ro" \
  -v "$PWD/infra/nginx/security-headers.inc:/etc/nginx/templates/security-headers.inc.template:ro" \
  -v "$PWD/infra/nginx/entrypoint.sh:/usr/local/bin/web-entrypoint.sh:ro" \
  --entrypoint /usr/local/bin/web-entrypoint.sh nginx:1.27-alpine >/dev/null

docker run -d --name "$API" --network "container:$NGINX" python:3.12-alpine sh -c '
  pip install -q --disable-pip-version-check --root-user-action=ignore uvicorn==0.34.0 &&
  cat > /app.py <<EOF
async def app(scope, receive, send):
    host = (scope.get("client") or ("none",))[0]
    await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-type", b"text/plain")]})
    await send({"type": "http.response.body", "body": host.encode()})
EOF
  cd / && exec uvicorn app:app --host 0.0.0.0 --port 8000 --log-level warning \
    --proxy-headers --forwarded-allow-ips 127.0.0.1' >/dev/null

for _ in $(seq 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/whoami" 2>/dev/null && break
  sleep 1
done

fails=0
# check <name> <expected client.host> [curl header args...]
check() {
  local name="$1" want="$2" got
  shift 2
  got="$(curl -sS "$@" "http://127.0.0.1:$PORT/api/whoami")"
  if [ "$got" = "$want" ]; then
    echo "PASS  $name: $got"
  else
    echo "FAIL  $name: API saw '$got', want '$want'"
    fails=$((fails + 1))
  fi
}

# bunny.net's CDN: X-Real-IP is the visitor; X-Forwarded-For lists the CDN and the visitor.
check "visitor behind the CDN" 198.51.100.7 \
  -H 'X-Real-IP: 198.51.100.7' -H 'X-Forwarded-For: 203.0.113.50, 198.51.100.7'
# Two visitors must not share a key.
check "second visitor behind the CDN" 198.51.100.8 \
  -H 'X-Real-IP: 198.51.100.8' -H 'X-Forwarded-For: 203.0.113.50, 198.51.100.8'
# X-Forwarded-For is never the source: a visitor can put anything in it, and the CDN keeps it.
check "client-written X-Forwarded-For ignored" 198.51.100.9 \
  -H 'X-Real-IP: 198.51.100.9' -H 'X-Forwarded-For: 192.0.2.66'
check "client-written X-Forwarded-For ignored (last entry)" 198.51.100.9 \
  -H 'X-Real-IP: 198.51.100.9' -H 'X-Forwarded-For: 198.51.100.9, 192.0.2.66'

if [ "$fails" -ne 0 ]; then
  echo "$fails case(s) failed"
  exit 1
fi
echo "all cases pass"
