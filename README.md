# AURA — Agent Usage & Resource Analytics

A local-first, Dockerized analytics platform for AI coding agent sessions (Claude Code today; Gemini, Codex, and friends on the roadmap). Aura watches your agent transcripts, transforms them through dbt, and surfaces cost, productivity, behavioural and pipeline-health signals through a Next.js dashboard. All data stays on your machine.

> *Spend, with receipts.*

---

## Why Aura

If you use Claude Code, Cursor, Aider, or any agentic coding assistant, you are already producing a goldmine of structured data on how you and your team think, debug, and ship. Aura turns that exhaust into a usable record:

- **Cost transparency** — every dollar spent, broken down by model, agent, project, person, and individual prompt. Every page that shows a cost reconciles to the same total for the same time range.
- **Operator visibility** — who is using which agent, what they ask for, and what gets delivered
- **Quality signals** — overkill detection (used Opus for a one-liner?), error rates per agent, cache hit rates, time-to-completion
- **Replay** — every prompt and response, tool call by tool call, with attribution back to the file paths that were edited
- **Pipeline observability** — built-in `/observability` tab shows ingestion freshness, dbt run status, source-freshness checks, and watcher failures so you always know whether the numbers you're looking at are current

Designed for individuals who want introspection on their own AI usage, and for teams who want a shared, honest picture of agent ROI.

---

## Architecture

Two truly independent stages: JSON → bronze (the watcher's job) and bronze → marts (dbt's job). dbt runs every 5 minutes against whatever lives in `raw_events` at that moment — it does not wait for backfill to finish, and an in-progress backfill does not block dbt cycles.

```
┌────────────────────┐    ┌─────────────────────────┐    ┌──────────────────────┐
│  ~/.claude/        │───▶│  watcher (Py)           │───▶│  /data/aura.duckdb   │
│  projects/*.jsonl  │    │  PollingObserver +      │    │  ── WRITE DB ──      │
│                    │    │  adapter +              │    │  raw_events          │
│                    │    │  ingest_checkpoints +   │    │  session_meta        │
│                    │    │  log_error()            │    │  watcher_errors      │
└────────────────────┘    └─────────────────────────┘    │  ingest_checkpoints  │
                                     │                   └──────────┬───────────┘
                                     │ dbt subprocess               │
                                     │ (seed → run → source         │ snapshot_worker
                                     │  freshness → test,           │ (atomic os.replace
                                     │  every 5 min)                │  every 2 s)
                                     ▼                              ▼
              ┌───────────────────────────┐         ┌──────────────────────────┐
              │  dbt models (in place)    │         │  /data/read/aura.duckdb  │
              │  ── BRONZE: raw_events    │         │  ── READ DB (snapshot) ──│
              │  ── STAGING: stg_*        │         └────────────┬─────────────┘
              │  ── INTERMEDIATE:         │                      │
              │     int_turns,            │                      │ stat()-aware
              │     int_entity_spend, …   │                      │ DuckDB connection
              │  ── MARTS: dim_sessions,  │                      │ (reopens on new
              │     fact_model_calls,     │                      │  inode)
              │     fact_turns,           │                      ▼
              │     fact_prompts,         │         ┌──────────────────────────┐
              │     fact_daily_spend,     │         │  Next.js 14 (App Router) │
              │     fact_spend_pace,      │         │  localhost:3000          │
              │     dim_apps, dim_people, │         │                          │
              │     dim_agents, …         │         │  /                       │
              └───────────┬───────────────┘         │  /apps, /agents, /people │
                          │                         │  /sessions, /errors      │
                          │ writes                  │  /observability ←────────┼─┐
                          │ target/                 └──────────────────────────┘ │
                          ▼                                                      │
              ┌───────────────────────────┐                                      │
              │  /data/artifacts/         │                                      │
              │  run_results.json         │──────────────────────────────────────┘
              │  sources.json             │  (read by /api/observability)
              │  manifest.json            │
              └───────────────────────────┘
```

| Surface | Language | Purpose |
|---|---|---|
| `watcher/` | Python 3.11 + `watchdog.PollingObserver` + DuckDB | Tail JSONL logs (works on Windows bind-mounts via polling), redact secrets, write `raw_events`, persist `watcher_errors` on every caught exception |
| `dbt/` | SQL + dbt-duckdb 1.11 | Staging → intermediate → marts. Includes `sources.yml` with freshness rules for `raw_events` (warn 5 min / error 30 min) and the `int_entity_spend` model that pre-joins event-timestamped cost to (app, agent, person) keys |
| `frontend/` | Next.js 14 (App Router) + TypeScript + DuckDB node-api | Dashboard, per-entity profile pages, and live-polling Observability tab. Connection layer checks the read DB's inode on every query so it never serves stale data after a snapshot |

---

## What you get on the dashboard

| Page | What it shows |
|---|---|
| **Dashboard** (`/`) | Hero "Spend, with receipts." + 14-day cost, KPI strip (active sessions, cache hit rate, tool calls, commits, errors, 30-day projection), daily spend chart, apps ledger, projects rollup, agents table (now with app/project context), files, errors, tool mix, providers, models, cache split, loudest prompt of the day |
| **Apps** (`/apps`) | Every app you've worked in — cost, sessions, turns, commits, agents in rotation |
| **App detail** (`/apps/[appId]`) | Agents in this app, **People in this app**, sibling apps in the project, recent sessions, full chronological prompt feed |
| **Agents** (`/agents`) | Every agent × app row (same agent name in different apps shows separately) — sortable by cost, sessions, turns |
| **Agent detail** (`/agents/[name]`) | **People delegating** to this agent, apps served, models routed to, recent sessions, top files touched, prompts directed at this agent |
| **People** (`/people`) | Rich operator cards: cost, sessions, turns, commits, apps chips, agents chips, % of org spend |
| **Person detail** (`/people/[personId]`) | Agents this person delegates to, apps they work in, recent sessions, **"What {name} actually types"** prompt log |
| **Sessions** (`/sessions`) | Filterable ledger of every session with title, model, turns, cost, person, agent |
| **Session detail** (`/sessions/[id]`) | Per-turn ledger with tabs for messages, prompts, agents, errors, files, tokens, tools, git |
| **Errors** (`/errors`) | Hard errors, warnings, tool failures across all sessions with filters by kind/tool/severity |
| **Observability** (`/observability`) | Pipeline health at a glance: bronze freshness, last dbt run status, errors in last hour/day, and ingestion volume for 1h / 1d / 7d windows. Polls every 10 s. |
| **Observability → Watcher** (`/observability/watcher`) | Bronze freshness card, files watched count, total bytes ingested, recent ingestion volume, full `watcher_errors` table with expandable stack traces |
| **Observability → dbt** (`/observability/dbt`) | Last run status pill, models pass/fail counts, per-model timings and error messages (from `target/run_results.json`), source freshness results (from `target/sources.json`), and a raw-JSON dump panel for deep debugging |

---

## Tech stack

- **Ingestion:** Python 3.11, `watchdog.PollingObserver` (works on Windows / Docker bind-mounts where inotify silently drops events), `duckdb` Python client
- **Storage:** DuckDB (single write DB at `/data/aura.duckdb`; read replica at `/data/read/aura.duckdb` produced by atomic snapshot)
- **Transform:** dbt 1.11 with `dbt-duckdb` adapter, staging / intermediate / marts pattern. `dbt source freshness` declared for `raw_events`; `target/run_results.json` and `target/sources.json` copied to `/data/artifacts/` after every cycle for frontend consumption
- **Pricing:** SCD-style `model_pricing` seed (per-tenant overrides supported)
- **Frontend:** Next.js 14 App Router, TypeScript, server components reading DuckDB directly. Connection layer uses `fs.stat().ino` to detect when the snapshot worker replaces the read DB and transparently reopens, so the page never serves stale data after a snapshot.
- **Container:** Docker Compose, two services (`watcher`, `frontend`) sharing the `./data` volume. Frontend mounts it read-only.

---

## Quick start (Docker)

**Requirements:** Docker, Docker Compose, and an existing `~/.claude/projects/` directory with at least one session.

```bash
git clone https://github.com/<you>/AURA.git
cd AURA
docker-compose up --build
```

Then open `http://localhost:3000`.

On first boot the `watcher` container:

1. Starts the `snapshot_worker` and `dbt_worker` threads **immediately** (they run independently of each other and of the backfill).
2. Backfills every existing `.jsonl` file under `AURA_LOGS_DIR`, **newest first**, so today's data shows up on the dashboard before the historical catch-up completes. Backfill is idempotent: byte offsets are tracked in `ingest_checkpoints`, so re-runs never double-write.
3. Hands off to the `PollingObserver`, which scans the logs directory every 10 s and processes any new bytes appended to JSONL files. Polling (not inotify) is used so the watcher works on Windows / Docker bind-mounts where filesystem events are unreliable.

While backfill is running, the `dbt_worker` fires its first cycle in parallel — it transforms whatever already exists in `raw_events` rather than waiting. Subsequent cycles run every `AURA_DBT_RUN_INTERVAL_MINUTES` minutes. The frontend reads from a snapshot of the DuckDB file (refreshed every 2 seconds when no dbt cycle is in flight) and the connection layer transparently reopens whenever the underlying file is replaced.

Environment variables (all have sensible defaults):

| Variable | Default | What it does |
|---|---|---|
| `AURA_LOGS_DIR` | `/logs/claude` | Where to look for `.jsonl` files inside the watcher container |
| `AURA_DB_PATH` | `/data/aura.duckdb` | Write-side DuckDB file |
| `AURA_READ_DB_PATH` | `/data/read/aura.duckdb` | Read-side snapshot (consumed by frontend). The basename must match `AURA_DB_PATH` so dbt-compiled views resolve against the same catalog name |
| `AURA_SNAPSHOT_INTERVAL` | `2` | Seconds between snapshot refreshes (snapshot worker waits while a dbt cycle holds the DB) |
| `AURA_DBT_RUN_INTERVAL_MINUTES` | `5` | How often the dbt cycle (`seed` → `run` → `source freshness` → `test`) runs |
| `CLAUDE_LOGS_DIR` | `~/.claude/projects` | Host-side path to mount into the watcher |
| `AURA_QUERY_TIMEOUT_MS` | `15000` | Maximum milliseconds a single DuckDB query may run before being aborted (frontend) |
| `AURA_REDACT_PAYLOAD` | `true` | Set to `false` to disable secret/base64 redaction in payload (raw JSONL passes through unchanged) |
| `AURA_MODEL_WINDOWS_JSON` | `{}` | Optional JSON object to override model context window sizes, e.g. `{"new-model-id":1000000}` |
| `AURA_ARTIFACTS_DIR` | `/data/artifacts` | Where the watcher copies dbt's `run_results.json` / `sources.json` / `manifest.json` after each cycle; the frontend reads these from the same path |

---

## Local development (no Docker)

```bash
# 1. Watcher
cd watcher
pip install -e .
python -m aura_watcher

# 2. dbt (after watcher has written some data)
cd dbt
dbt deps
dbt seed
dbt build

# 3. Frontend
cd frontend
npm install
npm run dev   # localhost:3000
```

Set `AURA_DB_PATH` and `AURA_READ_DB_PATH` in your shell to point at the actual DuckDB files; otherwise the defaults assume Docker paths.

---

## Configuring people

By default, every session is attributed to the host OS user (`getpass.getuser()`). To make the People page meaningful with friendly display names, create `~/.aura/people.json`:

```json
{
  "alice": { "name": "Alice Liu", "role": "Founding engineer" },
  "bob":   { "name": "Bob Chen",  "role": "Designer" }
}
```

Keys are OS usernames; values flow into `session_meta` at ingestion time.

---

## Screenshots

### Dashboard
High-level cost, KPIs, providers, models, errors — everything at a glance.
![Dashboard Overview](docs/screenshots/01-dashboard.png)

### Apps & App profile
Card grid of every app, then a per-app rollup with agents, people, sibling apps, and a full prompt feed.
![Apps](docs/screenshots/02-apps.png)
![App Profile](docs/screenshots/03-app-profile.png)

### People & Person profile
Rich operator cards on the list; a two-column profile with agents delegated to, apps worked in, and the operator's actual prompt log on the right.
![People](docs/screenshots/04-people.png)
![Person Profile](docs/screenshots/05-person-profile.png)

### Agent profile
Who delegates to this agent, which apps it serves, which models it gets routed to, and the prompts directed at it.
![Agent Profile](docs/screenshots/06-agent-profile.png)

### Sessions & Session detail
Filterable ledger of every session, then a per-turn breakdown of one session with tabs for messages, prompts, tools, files, errors, and git activity.
![Sessions](docs/screenshots/07-sessions.png)
![Session Detail](docs/screenshots/08-session-detail.png)

### Errors
Hard errors, warnings, and tool failures, filterable by kind and tool.
![Errors](docs/screenshots/09-errors.png)

---

## Notable behaviour

- **Pricing is SCD-aware.** The `model_pricing` seed has `valid_from` / `valid_to` columns; cost calculation joins on the timestamp of the model call, so historical sessions stay correctly priced even when rates change.
- **Cost is anchored to event timestamp, never session-start.** All cost aggregations across the dashboard derive from `fact_model_calls.calculated_cost` filtered by `CAST(ts AS DATE)`. Session-start (`dim_sessions.start_ts`) is used only for counting sessions and computing behavioural metrics — never for cost. A session that began yesterday but ran into today gets its yesterday's tokens counted on yesterday and its today's tokens counted on today.
- **Cost reconciles across all pages.** `int_entity_spend` pre-aggregates `fact_model_calls` to `(date × app/agent/person)` grain. Every range-filtered cost on Dashboard, Apps, Agents, People, and their detail pages pulls from this single source — so the total cost on the dashboard equals the sum of app costs equals the sum of agent costs for the same date range. No drift, no double-counting cache tokens, no provider/start-ts mismatch.
- **Cache hit rate uses the right denominator.** `cache_read / (cache_read + cache_write_5m + cache_write_1h)` — not `cache_read / input_tokens`.
- **Agents are tracked per app**, not just by name. `runner` in your Aura project and `runner` in another project show up as separate rows.
- **Overkill detection.** `fact_prompts` scores each external prompt on a complexity tier (S/M/L/XL by char count, tool calls, files edited) and compares it to the model tier (Haiku/Sonnet/Pro/Opus). If you used Opus to fix a typo, the prompt gets flagged.
- **Sidechain agent attribution.** When the main agent dispatches to a subagent via the `Task` tool, every event between dispatch and result is attributed to that subagent in `int_event_agent` and inherits into `dim_agents` / `fact_prompts`.
- **Backfill is all-or-nothing on the bronze layer.** `process_file` blocks on the snapshot lock if a dbt cycle is in flight, then writes the file's new bytes once the lock releases. Earlier versions short-circuited on a `dbt_running` flag, which silently dropped files whose entire processing happened to fall inside a dbt cycle — that bug is gone.
- **The frontend never serves stale data after a snapshot.** The watcher's snapshot uses `os.replace()` (atomic rename, new inode). The frontend's `lib/db.ts` checks the file's inode on every `getInstance()` call and reopens the DuckDB connection if it has changed.
- **Watcher failures are persisted.** Every `except` block in `main.py` calls `writer.log_error(source, file_path, exception)`, which writes a row to the `watcher_errors` table with full traceback. The Observability → Watcher page renders the most recent failures with expandable stack traces.

---

## How to Productionize for Multiple Users

To move Aura from a local single-user tool to a multi-user production environment:

1. **Centralized Log Ingestion.** Replace the local `~/.claude/projects` watch with a log-shipper (FluentBit, Promtail, or a custom agent) running on each user's machine, streaming `.jsonl` events to a centralized object store (S3) or queue (Kafka).
2. **Cloud Data Warehouse.** Migrate from local DuckDB to Snowflake, BigQuery, or MotherDuck. The dbt layer is portable; only the staging sources change.
3. **Hosted Dashboard.** Deploy the Next.js frontend to Vercel, AWS, or GCP. Add authentication (OAuth/SSO) and role-based access control. The frontend currently runs as server components — wire user identity into the read-path queries so people only see their own data unless they have a manager role.
4. **Scheduled Transformations.** Replace the embedded dbt worker loop with Airflow, Dagster, or dbt Cloud. Hourly rollups remain reasonable; the marts are designed to be fully rebuildable.

### Privacy for Multiple Users (Column Masking)

When rolling out to multiple users, it's critical to preserve privacy. **Before any data is shipped to a central server, message and prompt content will be masked so that only the individual user can see their own conversations — not other users, not managers, not admins.**

The following columns contain sensitive content and will be masked or hashed prior to central ingestion:

| Column | Location | Masking approach |
|---|---|---|
| `user_prompt` | `int_turns`, `fact_turns` | SHA-256 hash (content not recoverable) |
| `assistant_response` | `int_turns`, `fact_turns` | SHA-256 hash (content not recoverable) |
| `prompt_text_200` | `fact_prompts` | Masked / nulled out |
| `summary_200` | `fact_prompts` | Masked / nulled out |

**How it works:**
- The log-shipper (or a pre-ship dbt macro) replaces raw text in these columns with a cryptographic hash (SHA-256) before the data leaves the user's machine.
- All other columns — token counts, costs, tool names, timestamps, model IDs — travel unmasked and are safe to aggregate across users.
- A user viewing their own session detail page sees the full decrypted content sourced directly from their local DuckDB, not from the central copy.
- The central warehouse only ever receives hashed values, so even a compromised central store cannot reveal what any developer typed.

> **TODO (pre-central-deployment):** Implement column masking in `watcher/src/aura_watcher/redact.py` and/or a dbt pre-hook macro so that `user_prompt`, `assistant_response`, `prompt_text_200`, and `summary_200` are hashed/nulled before any outbound sync. See the column table above for target fields.

---

## Roadmap

- [ ] Gemini adapter (architecture is ready; the `model_pricing` seed already has Gemini rows)
- [ ] Codex / Aider adapters
- [ ] Column masking implementation (the privacy plumbing — see above)
- [ ] dbt schema tests (`not_null`, `unique`, `relationships`) for primary keys on every mart
- [ ] Multi-tenant auth — `tenant_id` is plumbed through the schema but always `'local'` today
- [ ] Anomaly detection: prompts that spike in cost, agents that suddenly start erroring out
- [ ] `aura.toml` config wiring (the file is defined but currently ignored; environment variables override everything)
- [ ] MetricFlow / dbt Semantic Layer adoption (semantic models for `model_calls` and `sessions` are sketched in `dbt/models/marts/aura_semantic.yml`; the frontend still queries SQL directly)
- [ ] Surface dbt source-freshness severity directly on the main Observability card (currently shown only on the dbt sub-page)

---

## Documentation

- [docs/code-review.md](docs/code-review.md) — full codebase audit with prioritized improvement notes

---

## License

MIT
