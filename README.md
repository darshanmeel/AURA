# AURA (Agent Usage & Resource Analytics)

Aura is a local, Dockerized analytics pipeline designed to monitor, analyze, and replay local AI agent sessions (Claude Code, Gemini, etc.). The system decouples data extraction, transformation, and presentation to support both high-level BI reporting and granular, interactive session replays.

## What it does
- **Ingests Data:** Continuously watches for local AI agent logs (`.jsonl` files) via a Python `watcher` process.
- **Stores Data:** Loads ingested data into DuckDB for fast and efficient analytical querying.
- **Transforms Data:** Uses `dbt` to run hourly rollups, build star schemas, and calculate pricing metrics based on usage.
- **Visualizes:** Provides a Next.js-based dashboard UI to explore agent sessions, monitor token usage, track costs, and review transcripts in real-time.

## What it is for
Aura is built for individuals and teams using AI coding agents locally. It provides insights into:
- How much money is being spent across different models (Sonnet, Haiku, Opus, etc.).
- Which projects consume the most tokens and execution time.
- Success and failure patterns in agent usage.
- Interactive replays of conversations and code modifications.

## How to use it
Aura runs entirely in Docker for simple setup and isolation.

1. **Prerequisites:** Make sure you have Docker and Docker Compose installed.
2. **Setup:** Clone this repository.
3. **Run:** From the root of the project, run:
   ```bash
   docker-compose up --build
   ```
4. **Access Dashboard:** Open your browser and navigate to `http://localhost:3000`.

The system will automatically start monitoring your default `~/.claude/projects` directory. You can configure paths, intervals, and ports in the `aura.toml` and `docker-compose.yml` files.

## How to Productionize for Multiple Users
To transition Aura from a local single-user tool to a multi-user production environment, follow these steps:
1. **Centralized Log Ingestion:** Instead of reading from local `~/.claude/projects` directories, deploy a lightweight log-shipper (like FluentBit or Promtail) on each user's machine to stream `.jsonl` logs to a centralized storage (e.g., S3 or a Kafka queue).
2. **Cloud Data Warehouse:** Migrate the database from a local DuckDB instance to a cloud-based warehouse such as Snowflake, BigQuery, or MotherDuck (cloud DuckDB) to handle concurrency and larger datasets.
3. **Hosted Dashboard:** Deploy the Next.js frontend to a cloud provider like Vercel, AWS, or GCP. Add user authentication (e.g., OAuth/SSO) and role-based access control (RBAC).
4. **Scheduled Transformations:** Use a production orchestrator like Airflow or Dagster to manage and schedule the `dbt` transformations, rather than relying on the local watcher loop.

### Privacy for Multiple Users (Data Anonymization)
When rolling out to multiple users, it's critical to preserve privacy. **To prevent managers from knowing what people are typing, individual message contents will be hashed.** 
- Instead of sending raw text prompts and AI completions to the central server, the log-shipper will send a cryptographic hash (e.g., SHA-256) of the message content.
- This allows the system to track metrics like message frequency, length, token counts, and session duration without exposing the actual sensitive intellectual property or private conversations of the developers.
