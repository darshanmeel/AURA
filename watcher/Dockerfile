FROM python:3.12-slim

WORKDIR /app

COPY watcher/ .
COPY dbt/ /app/dbt/

RUN pip install -e .

CMD ["python", "-m", "aura_watcher.main"]
