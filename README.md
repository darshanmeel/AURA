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
                                     │  every 5 min)                │  every 30 s)
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
| **Observability** (`/observability`) | Single consolidated pipeline view: derived verdict block, 5-stage flow strip (Watcher → Bronze → Silver → Gold → Consumers), medallion-layer cards with per-table rows / size / age, 4-column KPI grid, 1h/1d/7d ingestion sparklines, source freshness table, dbt test grid + per-relation breakdown, last 6 dbt invocations, live watcher errors feed, expandable `run_results.json` / `sources.json`. Polls every 10 s. |

---

## Project layout

```
AURA/
├── watcher/        Python package — JSONL adapter, DuckDB writer, snapshot + dbt workers
├── dbt/            dbt project — staging → intermediate → marts, model_pricing seed
├── frontend/       Next.js 14 app — dashboard, per-entity pages, Observability tab
├── docs/           Architecture notes, screenshots, code-review audit
└── .claude/        Agent definitions (runner, data-engineer, dbt-expert, frontend-engineer)
```

`watcher/`, `dbt/`, and `frontend/` are the three independent surfaces. Changes to one rarely need to touch the others — see the surface map in [CLAUDE.md](CLAUDE.md) for routing guidance.

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

While backfill is running, the `dbt_worker` fires its first cycle in parallel — it transforms whatever already exists in `raw_events` rather than waiting. Subsequent cycles run every `AURA_DBT_RUN_INTERVAL_MINUTES` minutes. The frontend reads from a snapshot of the DuckDB file (refreshed every 30 seconds when no dbt cycle is in flight, matched to `frontend.revalidate_seconds`) and the connection layer transparently reopens whenever the underlying file is replaced.

Environment variables (all have sensible defaults):

| Variable | Default | What it does |
|---|---|---|
| `AURA_LOGS_DIR` | `/logs/claude` | Where to look for `.jsonl` files inside the watcher container |
| `AURA_DB_PATH` | `/data/aura.duckdb` | Write-side DuckDB file |
| `AURA_READ_DB_PATH` | `/data/read/aura.duckdb` | Read-side snapshot (consumed by frontend). The basename must match `AURA_DB_PATH` so dbt-compiled views resolve against the same catalog name |
| `AURA_SNAPSHOT_INTERVAL` | `30` | Seconds between snapshot refreshes (snapshot worker waits while a dbt cycle holds the DB). Matches `frontend.revalidate_seconds`; lower values cause the frontend's inode-keyed DuckDB connection cache to invalidate mid-request and make warm hits as slow as cold ones. |
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

Captured against the live local stack with 13 Haiku Playwright agents.
For per-screen documentation see [docs/screens/](docs/screens/) — start
with [OVERVIEW.md](docs/screens/OVERVIEW.md) for navigation and
[HOW-IT-WORKS.md](docs/screens/HOW-IT-WORKS.md) for architecture.

### Dashboard
Single summary screen — cost, token volume, ledgers for apps/projects/agents,
heatmap, side panels, and Skills & MCPs at the bottom.
![Dashboard](docs/screens/dashboard.png)

### Tokens drill-down
Token spend broken down by type, provider, model, and agent. Hourly
buckets on `range=today`, daily otherwise. Distinct colour palette per
token type (teal/gold/orange/violet/slate).
![Tokens](docs/screens/tokens-page.png)

### Sessions list & Session detail
Filterable ledger of every session with new 🧩 (skills) + ⚡ (MCPs) count
columns and multi-agent rendering; then a per-session deep-dive across
9 tabs.
![Sessions](docs/screens/sessions-list.png)
![Session Detail](docs/screens/session-detail.png)

### Apps & App detail
Card grid by cost; per-app rollup with sessions, agents, people, sibling
apps, prompt feed, and a "Skills & MCPs in this app" panel.
![Apps](docs/screens/apps-list.png)
![App Detail](docs/screens/app-detail.png)

### Agents & Agent detail
Subagent roster with **real attribution** (technical-writer, frontend-engineer,
code-reviewer, …) — `fact_model_calls.agent` now joins
`int_event_agent.agent_resolved` so spend no longer lumps under one
`claude` row. Footnote on the list explains the `main` bucket.
![Agents](docs/screens/agents-list.png)
![Agent Detail](docs/screens/agent-detail.png)

### People & Person detail
Operator roster with real names (311 / 349 sessions resolve to the
configured `AURA_DEFAULT_PERSON_*`); per-person profile with agents
delegated to, apps worked in, and the operator's prompt log.
![People](docs/screens/people-list.png)
![Person Detail](docs/screens/person-detail.png)

### Errors
Hard errors, warnings, and tool failures from `fact_errors`, filterable
by kind and tool. Timestamps now carry date + time (e.g. `May 28 ·
09:57:26`).
![Errors](docs/screens/errors-list.png)

### Observability
Pipeline health at a glance — verdict, flow strip, medallion layer ages,
KPI grid, ingestion volume, source freshness, dbt tests, recent watcher
errors. Polls every 10 s via `/api/observability`.
![Observability](docs/screens/observability.png)

---

## Notable behaviour

- **Pricing is SCD-aware.** The `model_pricing` seed has `valid_from` / `valid_to` columns; cost calculation joins on the timestamp of the model call, so historical sessions stay correctly priced even when rates change.
- **Cost is anchored to event timestamp, never session-start.** All cost aggregations across the dashboard derive from `fact_model_calls.calculated_cost` filtered by `CAST(ts AS DATE)`. Session-start (`dim_sessions.start_ts`) is used only for counting sessions and computing behavioural metrics — never for cost. A session that began yesterday but ran into today gets its yesterday's tokens counted on yesterday and its today's tokens counted on today.
- **Cost reconciles across all pages.** `int_entity_spend` pre-aggregates `fact_model_calls` to `(date × app/agent/person)` grain. Every range-filtered cost on Dashboard, Apps, Agents, People, and their detail pages pulls from this single source — so the total cost on the dashboard equals the sum of app costs equals the sum of agent costs for the same date range. No drift, no double-counting cache tokens, no provider/start-ts mismatch.
- **Cache hit rate uses the right denominator.** `cache_read / (cache_read + cache_write_5m + cache_write_1h)` — not `cache_read / input_tokens`.
- **Agents are tracked per app**, not just by name. `runner` in your Aura project and `runner` in another project show up as separate rows.
- **Overkill detection.** `fact_prompts` scores each external prompt on a complexity tier (S/M/L/XL by char count, tool calls, files edited) and compares it to the model tier (Haiku/Sonnet/Pro/Opus). If you used Opus to fix a typo, the prompt gets flagged.
- **Sidechain agent attribution.** When the main agent dispatches to a subagent via the `Task` tool, every event between dispatch and result is attributed to that subagent in `int_event_agent` and inherits into `dim_agents` / `fact_prompts`.
- **Backfill is all-or-nothing on the bronze layer.** Both `process_file` (backfill / polling path) and `on_created` (new-file event path) block on `_snapshot_lock` if a dbt cycle is in flight, then write once the lock releases. Earlier versions short-circuited on a `dbt_running` flag in both handlers, which silently dropped any file whose entire processing happened to fall inside a dbt cycle — that bug is gone from both paths.
- **The frontend never serves stale data after a snapshot.** The watcher's snapshot uses `os.replace()` (atomic rename, new inode). The frontend's `lib/db.ts` checks the file's inode on every `getInstance()` call and reopens the DuckDB connection if it has changed.
- **Watcher failures are persisted.** Every `except` block in `main.py` calls `writer.log_error(source, file_path, exception)`, which writes a row to the `watcher_errors` table with full traceback. The Observability → Watcher page renders the most recent failures with expandable stack traces.

---

## Performance & materialization strategy

Every dbt model in this repo is currently `table` (full rebuild on each cycle) or `view`. **No model is `incremental`.** At the data scale this tool was designed for — one developer's transcripts, on the order of 100k–500k events in `raw_events` — a full rebuild every 5 minutes takes ~30–60 s and is well inside the dbt cycle budget. Switching to incremental at this scale would add complexity (lookback windows for late-arriving JSONL bytes, `merge` strategies for dimensions that aggregate facts) without measurable wall-clock benefit.

**When to add incremental models.** Revisit this once `raw_events` crosses roughly **1M rows** or a full `dbt build` cycle starts pushing past 2–3 minutes. The natural candidates, in order:

1. `fact_model_calls` — append-only on `event_ts`, easy `unique_key=event_uuid`, `incremental_strategy='delete+insert'` over a lookback window.
2. `fact_tool_executions` and `fact_turns` — same shape, both join through `fact_model_calls`.
3. `fact_prompts` — append-only per `prompt_uuid`, but the complexity-tier computation reads its own history; a 2 h lookback window is enough.
4. `int_entity_spend` — incremental on `(date, app_id/agent/person_id)` grain, but only after the upstream facts are incremental too.

**How you'd do it in production.** The pattern (illustrative, not yet in the repo) is the standard dbt-incremental shape:

```sql
-- dbt/models/marts/fact_model_calls.sql (hypothetical production form)
{{ config(
    materialized='incremental',
    unique_key='event_uuid',
    incremental_strategy='delete+insert',
    on_schema_change='append_new_columns'
) }}

SELECT ...
FROM {{ ref('stg_events') }}
WHERE event_type = 'assistant'

{% if is_incremental() %}
  -- 2 h lookback: covers any late-arriving bytes the watcher backfills after
  -- a JSONL was force-flushed (Claude Code can rewrite the tail when a session
  -- is resumed). Anything older than 2 h is considered settled.
  AND event_ts > (SELECT MAX(event_ts) - INTERVAL '2 hours' FROM {{ this }})
{% endif %}
```

Dimensions that derive from facts (`dim_sessions`, `dim_apps`, `dim_agents`, `dim_people`) stay `table` even after the facts go incremental — they're cheap to fully rebuild from the now-incremental fact tables, and incremental dimensions are a known source of drift bugs (a session whose cost changed after the fact gets stale dimension rows). Keep the line: facts are append-only and can be incremental; dimensions roll up the current state of facts and should rebuild.

Beyond the dbt layer, the `raw_events` bronze table is already append-only at ingest time (the watcher tracks byte offsets in `ingest_checkpoints` and never re-reads settled prefix bytes), so the bronze stage is effectively incremental without dbt being involved. The bottleneck at scale will be the silver/gold dbt rebuilds, which is what the above plan targets.

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
- [ ] MetricFlow / dbt Semantic Layer adoption — wire the existing `dbt/models/marts/aura_semantic.yml` semantic models through to the frontend so KPIs are defined once and reconciled by the layer instead of by hand-written SQL in `frontend/lib/queries/*`
- [ ] Convert append-only facts to `incremental` once `raw_events` crosses ~1M rows (see *Performance & materialization strategy* above)
- [ ] Surface dbt source-freshness severity directly on the main Observability card (currently shown only on the dbt sub-page)

---

## Documentation

- [docs/code-review.md](docs/code-review.md) — full codebase audit with prioritized improvement notes

---

## License

MIT
