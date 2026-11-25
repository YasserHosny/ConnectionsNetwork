#!/bin/sh
# Container start for the web image: render the Nginx config and write runtime-config.json from
# the environment, then run Nginx. Neither the Supabase project URL nor its key is baked into
# the image, so one image serves every environment.
set -eu

fail() {
    echo "web-entrypoint: $1" >&2
    exit 1
}

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY is required}"
# 127.0.0.1: the api container in the same bunny.net app. docker-compose.yml sets `api`.
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
export SUPABASE_URL BACKEND_HOST

# The values end up inside an Nginx config and a JSON file, so refuse anything that could break
# out of either: SUPABASE_URL must be a bare origin (it is also a CSP source, where ';' or a
# space would start a new directive), the key must look like a key.
printf '%s' "$SUPABASE_URL" | grep -Eq '^https?://[A-Za-z0-9.:-]+$' ||
    fail "SUPABASE_URL must be a bare origin such as https://<ref>.supabase.co (no path, no trailing slash)"
printf '%s' "$SUPABASE_ANON_KEY" | grep -Eq '^[A-Za-z0-9._~+/=-]+$' ||
    fail "SUPABASE_ANON_KEY contains characters a Supabase key never has"
printf '%s' "$BACKEND_HOST" | grep -Eq '^[A-Za-z0-9.-]+$' ||
    fail "BACKEND_HOST must be a host name"

# TRUST_CDN_REAL_IP=true: the API is given the visitor's address from X-Real-IP, whoever the
# peer is. Only where bunny.net's CDN is the sole way in (the hosted app: its endpoint is the
# CDN, the API container publishes no port) and its edge replaces any X-Real-IP a visitor sends
# (deploy checklist step 10 checks that on hosted). Never where clients reach Nginx directly,
# such as docker compose's published port: there it would let any client choose its rate-limit
# key. A value that does not look like an IPv4 or IPv6 address falls back to the peer.
case "${TRUST_CDN_REAL_IP:-false}" in
true)
    cat <<'EOF'
map $http_x_real_ip $api_client {
    "~^[0-9A-Fa-f:.]{2,45}$" $http_x_real_ip;
    default $remote_addr;
}
EOF
    ;;
false)
    cat <<'EOF'
# TRUST_CDN_REAL_IP is not true: the client address is Nginx's peer.
map $remote_addr $api_client {
    default $remote_addr;
}
EOF
    ;;
*)
    fail "TRUST_CDN_REAL_IP must be true or false"
    ;;
esac >/etc/nginx/conf.d/real-ip.inc

VARS='${BACKEND_HOST} ${SUPABASE_URL}'
envsubst "$VARS" </etc/nginx/templates/default.conf.template >/etc/nginx/conf.d/default.conf
envsubst "$VARS" </etc/nginx/templates/security-headers.inc.template >/etc/nginx/conf.d/security-headers.inc

printf '{"supabaseUrl":"%s","supabaseAnonKey":"%s"}\n' "$SUPABASE_URL" "$SUPABASE_ANON_KEY" \
    >/usr/share/nginx/html/runtime-config.json

nginx -t >/dev/null
exec nginx -g 'daemon off;'
