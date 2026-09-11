FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH="/opt/provider-archive" \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src ./src
COPY --from=provider_archive / /opt/provider-archive/
RUN uv sync --frozen --no-dev

EXPOSE 8090

CMD ["python", "-m", "seo_workers", "keywords"]
