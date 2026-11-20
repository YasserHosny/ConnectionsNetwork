FROM python:3.12-slim

# uv, pinned. The lockfile format (revision 3) needs a recent release.
COPY --from=ghcr.io/astral-sh/uv:0.11.0 /uv /uvx /bin/

# Non-root user and group.
RUN groupadd -g 1001 appgroup && \
    useradd -u 1001 -g appgroup -m -s /bin/bash appuser

WORKDIR /app

ENV UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

# Dependencies first, from the lockfile only, so this layer is reused until the lock changes.
COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Then the package itself, installed (not editable) from the lockfile's resolution.
COPY apps/api/src ./src
RUN uv sync --frozen --no-dev --no-editable

USER appuser

# The one address uvicorn trusts forwarded headers from (X-Forwarded-For / -Proto), so SlowAPI's
# per-IP limit sees the real client. The Nginx container shares the bunny.net app with this one,
# so its connections arrive from localhost. Never "*": any client could then spoof its address.
# docker-compose.yml overrides this with the compose network, where Nginx is another container.
ENV FORWARDED_ALLOW_IPS=127.0.0.1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=4)"]

# Exactly ONE worker: SlowAPI keeps its rate-limit counters in process memory, so a second worker
# would double every budget. No --log-config: configure_logging() (shared/logging.py) owns
# uvicorn's handlers, its JSON format and its redaction.
CMD ["sh", "-c", "exec uvicorn connections_api.main:app --host 0.0.0.0 --port 8000 --workers 1 --proxy-headers --forwarded-allow-ips \"$FORWARDED_ALLOW_IPS\""]
