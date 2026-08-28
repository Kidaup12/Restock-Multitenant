FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

WORKDIR /app

# dependency layer (cached unless the lockfile changes)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# project layer
COPY src ./src
COPY config ./config
RUN uv sync --frozen --no-dev

CMD ["sh", "-c", "uv run uvicorn audit_engine.api:app --host 0.0.0.0 --port ${PORT:-8000}"]
