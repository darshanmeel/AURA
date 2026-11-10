FROM python:3.12-slim

WORKDIR /app

# Unbuffered stdout/stderr so `docker logs` shows watcher + dbt output in real time.
ENV PYTHONUNBUFFERED=1

# Node.js 20 LTS for the number-verify runner (scripts/verify/run_all.mjs).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Dependencies first, so a source change does not reinstall dbt/duckdb: install
# the pinned deps from pyproject.toml with a stub package, then drop the stub.
COPY watcher/pyproject.toml ./
RUN mkdir -p src/aura_watcher && touch src/aura_watcher/__init__.py \
    && pip install --no-cache-dir . && pip uninstall -y aura-watcher && rm -rf src build

COPY watcher/ .
RUN pip install --no-cache-dir --no-deps -e .

COPY dbt/ /app/dbt/
COPY scripts/ /app/scripts/
RUN cd /app/scripts/verify && npm install --omit=dev

CMD ["python", "-m", "aura_watcher.main"]
