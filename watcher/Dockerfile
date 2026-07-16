FROM python:3.12-slim

WORKDIR /app

# Unbuffered stdout/stderr so `docker logs` shows watcher + dbt output in real time.
ENV PYTHONUNBUFFERED=1

COPY watcher/ .
COPY dbt/ /app/dbt/

RUN pip install -e .

# Node.js 20 LTS for the number-verify runner (scripts/verify/run_all.mjs).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY scripts/ /app/scripts/
RUN cd /app/scripts/verify && npm install --omit=dev

CMD ["python", "-m", "aura_watcher.main"]
