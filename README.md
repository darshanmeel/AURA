# AURA (Agent Usage & Resource Analytics)

Aura is a local, Dockerized analytics pipeline designed to monitor, analyze, and replay local AI agent sessions (Claude Code, Gemini, etc.). The system decouples data extraction, transformation, and presentation to support both high-level BI reporting and granular, interactive session replays. 

It provides an out-of-the-box solution for teams and individual developers who rely heavily on AI coding assistants, offering transparency into the real cost, duration, and efficiency of every single agent interaction.

## What it does
- **Ingests Data:** Continuously watches for local AI agent logs (`.jsonl` files) via a Python `watcher` process. It gracefully handles large files and real-time updates without locking up your machine.
- **Stores Data:** Loads ingested data into DuckDB for fast and efficient analytical querying, ensuring all your data stays strictly local.
- **Transforms Data:** Uses `dbt` to run hourly rollups, build star schemas, and calculate pricing metrics based on usage, giving you accurate ROI indicators.
- **Visualizes:** Provides a Next.js-based dashboard UI to explore agent sessions, monitor token usage, track costs, and review transcripts in real-time. The frontend makes it easy to search through historical chats or jump straight to a specific code modification.

## Screenshots

Here is a look at the Next.js dashboard you'll be using to monitor your agents:

### Dashboard Overview
The main dashboard gives a high-level view of token usage, total active sessions, and overall cost metrics over time.
![Dashboard Overview](docs/screenshots/01-dashboard.png)

### App Usage & Agent Profiles
See detailed token spending broken down by application and individual agent roles.
![App Profile](docs/screenshots/03-app-profile.png)
![Agent Profile](docs/screenshots/06-agent-profile.png)

### People & Team Tracking
For multi-user setups, track metrics across different team members.
![People Profile](docs/screenshots/05-person-profile.png)

### Sessions & Deep Dives
Dive deep into individual sessions. Replay exact conversational transcripts and code edits side-by-side.
![Sessions List](docs/screenshots/07-sessions.png)
![Session Detail](docs/screenshots/08-session-detail.png)

### Error Tracking
Monitor failure rates and agent errors to see when and why your assistant is struggling.
![Error Tracking](docs/screenshots/09-errors.png)

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
