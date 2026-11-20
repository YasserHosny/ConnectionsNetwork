# Stage 1: build the Angular app
FROM node:24-alpine AS build

WORKDIR /app/apps/web

RUN corepack enable && corepack prepare pnpm@12.16.1 --activate

# Install exactly as CI does: apps/web has its own lockfile and is not part of the root
# workspace here, so --ignore-workspace. The strict build-script check is relaxed instead of the
# root allowBuilds list (esbuild, lmdb and the others only fetch prebuilt binaries).
COPY apps/web/package.json apps/web/pnpm-lock.yaml ./
RUN pnpm install --ignore-workspace --frozen-lockfile --config.strict-dep-builds=false

# packages/ sits next to apps/web/: tsconfig paths reach ../../packages/domain-types and
# ../../packages/i18n, and apps/web/i18n is a symlink to ../../packages/i18n (the catalogues).
COPY packages/ /app/packages/
COPY apps/web/ ./
RUN pnpm exec ng build

# Stage 2: serve with Nginx
FROM nginx:1.27-alpine

ARG BUILD_SHA=dev

COPY --from=build /app/apps/web/dist/web/browser /usr/share/nginx/html
COPY infra/nginx/nginx.conf /etc/nginx/templates/default.conf.template
COPY infra/nginx/security-headers.inc /etc/nginx/templates/security-headers.inc.template
COPY infra/nginx/entrypoint.sh /usr/local/bin/web-entrypoint.sh

# The committed runtime-config.json is a local-development placeholder; the entrypoint writes
# the real one from the environment at every start.
RUN rm -f /usr/share/nginx/html/runtime-config.json && \
    printf '%s\n' "$BUILD_SHA" > /usr/share/nginx/html/version.txt

ENV BACKEND_HOST=api

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/web-entrypoint.sh"]
