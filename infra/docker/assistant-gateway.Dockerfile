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
COPY apps/assistant-gateway/pyproject.toml apps/assistant-gateway/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Then the package itself, installed (not editable) from the lockfile's resolution. The wheel
# carries migrations/ inside the package, so `python -m assistant_gateway.migrate` works here.
COPY apps/assistant-gateway/src ./src
COPY apps/assistant-gateway/migrations ./migrations
RUN uv sync --frozen --no-dev --no-editable

# The YAML configuration (caps, models, prices). Changing a cap is a merge and a deploy.
COPY apps/assistant-gateway/config ./config

USER appuser

# The production default. docker-compose.yml points local runs at config/local.yaml.
ENV AG_CONFIG_PATH=/app/config/production.yaml

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/healthz', timeout=4)"]

# Exactly ONE worker: the per-key rate limits (SlowAPI) live in process memory, so a second
# worker would double every budget. No --proxy-headers: nothing sits in front of this container.
# It is reached only from connections-api on localhost, has no public endpoint, and the rate
# limit is per app key, not per client address.
CMD ["uvicorn", "assistant_gateway.main:app", "--host", "0.0.0.0", "--port", "8100", "--workers", "1"]
