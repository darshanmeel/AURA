FROM python:3.12-slim

WORKDIR /app

# Unbuffered stdout/stderr so `docker logs` shows watcher + dbt output in real time.
ENV PYTHONUNBUFFERED=1

COPY watcher/ .
COPY dbt/ /app/dbt/

RUN pip install -e .

CMD ["python", "-m", "aura_watcher.main"]
