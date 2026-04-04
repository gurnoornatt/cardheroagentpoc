FROM python:3.12-slim

# Install Node 20 + curl
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Python deps — install before copying source for layer cache
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# Agent Node deps — install before copying source for layer cache
COPY newpoc/agent/package.json newpoc/agent/
RUN cd newpoc/agent && npm install

# Copy all source
COPY . .

# Mount point for persistent SQLite volume
RUN mkdir -p /data

EXPOSE 8001
CMD uv run uvicorn newpoc.backend.main:app --host 0.0.0.0 --port ${PORT:-8001}
