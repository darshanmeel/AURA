# Aura — Agent Usage & Resource Analytics

**Status:** Design draft v2 · 2026-05-23
**Owner:** Darshan
**Audience for the product:** open-source release for individual developers, with a path to a multi-tenant SaaS later.

> v2 reflects findings from a ground-truth review against real Claude Code JSONL files. The four blockers fixed in v2 are flagged inline as ⚠️ **v2 fix**.

---

## 1. Purpose

Aura is a local-first analytics tool that turns AI-coding-agent transcripts (Claude Code today; Gemini, Codex, OpenAI later) into actionable insights for the developer running them: live context usage, per-session and daily cost, token mix, tool-call patterns, and project-level activity. It is **not** a logging tool — it's a *reflection* tool.

### Two-mode dashboard

| Mode | Latency | Backing | Reader |
| --- | --- | --- | --- |
| **Live** | ~2 s from JSONL append | Raw tables in a snapshot of DuckDB | Streamlit fragments, auto-refresh ~2 s |
| **Daily / historical** | Hourly refresh | dbt-materialized rollups | Streamlit pages reading dbt marts |

⚠️ **v2 fix (DuckDB concurrency):** the watcher writes to `aura.duckdb` and periodically (default 2 s) copies it to `aura_read.duckdb`. Streamlit only ever opens the read snapshot. This avoids DuckDB's hard one-writer / no-concurrent-reader restriction without needing an RPC layer.

### Out of scope (explicitly)
- A general-purpose BI tool. No Lightdash, no Metabase. Streamlit only.
- Editing or replaying sessions back into Claude Code. Read-only.
- Long-term cloud storage. DuckDB file lives on the user's disk.
- Anthropic Console / Cloud API integration in v0.1–v0.4 (see phasing).

---

## 2. Audience & deployment model

| Phase | Audience | Deployment |
| --- | --- | --- |
| OSS | Solo developer | `docker compose up` on their laptop, mounting `~/.claude/projects` |
| SaaS-ready (later) | Teams / hosted | Same schema, with `tenant_id` already present on every table |

**Tenancy from day one:** every table carries `tenant_id` (default `'local'` in OSS mode). Primary keys are scoped `(tenant_id, …)` so two tenants with colliding UUIDs do not clash.

**Other forward-compat doors deliberately addressed now:**
- `model_pricing` will accept a nullable `tenant_id` override column (private contracts).
- `[ui] timezone` config — OSS default `UTC`; SaaS will read per-tenant.
- `redact_payload` flag in config from v0.1 — keeps secrets out of the DuckDB file even on the developer's own laptop (it's still a goldmine if it leaks).

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                     User's machine                             │
│                                                                │
│   ~/.claude/projects/**/*.jsonl     ~/.gemini/tmp/*  (future)  │
│              │                                                 │
│              ▼                                                 │
│   ┌──────────────────────┐                                     │
│   │  watcher (Python)    │  watchdog + 200ms debounce          │
│   │  - claude_adapter    │  per-event read from last_offset    │
│   │  - gemini_adapter (later)                                  │
│   │  - snapshot worker   │  copies aura.duckdb → aura_read     │
│   └──────────┬───────────┘                                     │
│              ▼                                                 │
│   ┌──────────────────────────────────────────────────────┐     │
│   │  aura.duckdb  (read/write — owned by watcher only)   │ ◄── dbt (hourly subprocess)
│   │     raw_events, ingest_checkpoints, marts            │     builds marts in-place
│   └──────────┬───────────────────────────────────────────┘     │
│              ▼ (snapshot copy ~2 s, file copy + force_checkpoint)│
│   ┌──────────────────────────┐                                  │
│   │  aura_read.duckdb (RO)   │                                  │
│   └──────────┬───────────────┘                                  │
│              ▼                                                  │
│   ┌──────────────────────────┐                                  │
│   │  Streamlit (port 8501)   │                                  │
│   │  - Live panels           │                                  │
│   │  - Daily dashboard       │                                  │
│   │  - Session deep-dive     │                                  │
│   └──────────────────────────┘                                  │
└────────────────────────────────────────────────────────────────┘
```

Three Docker services in `docker-compose.yml`:

| Service | Purpose | Notes |
| --- | --- | --- |
| `watcher` | Real-time JSONL → DuckDB + snapshot copy + invokes dbt | Single process; the only writer to `aura.duckdb`. Runs dbt as a subprocess on an internal hourly timer (no separate dbt container — saves memory on laptops). |
| `streamlit` | Web UI on `localhost:8501` | Opens `aura_read.duckdb` only. |
| `aura-cli` (optional) | One-shot ops (`backfill`, `dbt run`, `reset`, `redact-existing`) | On-demand container. |

A single named volume `aura_data` holds both DuckDB files and dbt artifacts. Host mounts `~/.claude/projects` (read-only) into `watcher`.

---

## 4. Ingestion — real-time watcher

### Mechanism
- Library: `watchdog` (cross-platform; on Windows wraps `ReadDirectoryChangesW`).
- Watches `**/*.jsonl` recursively under each configured root.
- On `FileModifiedEvent` / `FileCreatedEvent`, the file path is enqueued.
- A worker thread debounces events (200 ms window) and processes each file once per burst.
- Commit cadence: one DuckDB transaction per file per burst — includes both the row inserts and the checkpoint update.

### Per-file processing (idempotent)
1. Look up `ingest_checkpoints[tenant_id, file_path]` → `last_offset`, `last_line_uuid`.
2. If file size < `last_offset` → file was truncated/rotated → reset to 0.
3. `open(file, 'rb').seek(last_offset)`, read remainder.
4. Split on `\n`. The trailing fragment may be a partial line — keep its bytes but do not parse it. Advance `last_offset` only to the start of that fragment.
5. For each complete line: `json.loads`, dispatch to the right adapter, append parsed rows.
6. Update checkpoint within the same transaction.

### Adapter interface
```python
class Adapter(Protocol):
    name: str  # 'claude' | 'gemini' | ...
    def parse_line(self, raw: dict, ctx: FileContext) -> RawEvent: ...
```
- Adapters do **not** compute cost. They normalize fields and write one `raw_events` row per JSONL line.
- ⚠️ **v2 fix (unknown event types):** unknown `type` values are not dropped — they land in `raw_events` with `event_type = '<original type verbatim>'` and the full JSON in `payload`. The JSONL schema evolves; the watcher must never silently discard.

### What the Claude adapter actually emits (ground-truthed against real files)

Top-level `type` values seen in real JSONL include: `user`, `assistant`, `last-prompt`, `permission-mode`, `attachment`, `file-history-snapshot`, `ai-title`, `queued_command`, `tools_changed`, `skill_listing`, `task_reminder`, `mcp_instructions_delta`, `deferred_tools_delta`, `command_permissions`, `queue-operation`. The adapter stores `event_type` verbatim; we do not validate against an enum.

⚠️ **v2 fix (no top-level tool_use):** `tool_use` and `tool_result` are **not** top-level event types in Claude Code's JSONL. They live nested inside `message.content[]` of `assistant` and `user` rows respectively. The Claude adapter denormalises hot fields (model, usage, cwd, gitBranch, isSidechain, parentUuid, requestId, message.id, message.stop_reason) onto `raw_events`. Tool calls are exploded into `raw_tool_calls` in the staging dbt model, not in the watcher (keeps the watcher simple and the explode logic testable in SQL).

### Context % computed in the watcher
⚠️ **v2 fix (correct formula):** for each `assistant` row, the watcher computes
```
context_pct = (input_tokens + cache_creation_input_tokens + cache_read_input_tokens) / context_window_tokens
```
and writes it to `raw_events.context_pct`. **No cumulative sum. No reset logic.** Each turn's `usage` object already reflects the full prompt sent for that turn (most of it as cache reads). This matches what Claude Code's own status bar displays.

`context_window_tokens` is loaded once from the `model_pricing` seed at watcher startup and cached in memory.

### Initial backfill
On startup, the watcher walks every configured root once and processes each file from `last_offset` (or 0). Same code path as live events.

---

## 5. Storage layer

### 5.1 Raw tables (watcher writes; one row per JSONL line)

⚠️ **v2 fix (PK and missing fields):** primary key is the line's own `uuid` (every Claude Code JSONL line carries one), scoped by `tenant_id`. Critical denormalised fields all added.

```sql
CREATE TABLE raw_events (
  tenant_id        TEXT NOT NULL DEFAULT 'local',
  uuid             TEXT NOT NULL,              -- JSONL line uuid
  session_id       TEXT NOT NULL,
  agent            TEXT NOT NULL,              -- 'claude' | 'gemini' | ...
  event_type       TEXT NOT NULL,              -- stored verbatim from JSONL "type"
  ts               TIMESTAMP NOT NULL,
  file_path        TEXT NOT NULL,
  byte_offset      BIGINT NOT NULL,

  -- threading / grouping
  parent_uuid      TEXT,                       -- for turn threading
  request_id       TEXT,                       -- groups multi-block assistant lines
  message_id       TEXT,                       -- ditto; used for dedup (see §5.2)
  is_sidechain     BOOLEAN NOT NULL DEFAULT FALSE,
  stop_reason      TEXT,                       -- assistant only

  -- environment
  cwd              TEXT,                       -- working directory at the time of the line
  git_branch       TEXT,
  claude_version   TEXT,                       -- schema-evolution canary

  -- usage (assistant rows only; NULL elsewhere)
  model            TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cache_creation_input_tokens INTEGER,
  ephemeral_5m_input_tokens   INTEGER,         -- breakdown of cache_creation
  ephemeral_1h_input_tokens   INTEGER,
  cache_read_input_tokens     INTEGER,
  context_pct      DOUBLE,                     -- computed in watcher per §4

  -- full original line for replay + defensive parsing
  payload          VARCHAR NOT NULL,           -- stored as text; json_extract on read

  PRIMARY KEY (tenant_id, uuid)
);

CREATE INDEX raw_events_session_ts ON raw_events (tenant_id, session_id, ts);
CREATE INDEX raw_events_message    ON raw_events (tenant_id, message_id);
CREATE INDEX raw_events_ts         ON raw_events (tenant_id, ts);

CREATE TABLE ingest_checkpoints (
  tenant_id        TEXT NOT NULL DEFAULT 'local',
  file_path        TEXT NOT NULL,
  last_offset      BIGINT NOT NULL,
  last_line_uuid   TEXT,
  last_seen_at     TIMESTAMP NOT NULL,
  PRIMARY KEY (tenant_id, file_path)
);
```

Note: `thinking_tokens` is intentionally absent. Thinking is a *content-block type* inside `assistant` messages; it is billed inside `output_tokens` by Anthropic. There is no separate `usage.thinking_tokens` field.

Note: `payload` is `VARCHAR`, not `JSON`. DuckDB's `JSON` type re-parses on every read; storing as text and using `json_extract` on demand is materially faster for this workload.

### 5.2 dbt marts (hourly refresh, built into the same DuckDB file)

⚠️ **v2 fix (message-id dedup):** the staging layer is where the per-message-id dedup happens. `raw_events` is intentionally lossless — every JSONL line is stored, including the duplicated `usage` payload that Claude Code writes once per content block.

| Layer | Model | Purpose |
| --- | --- | --- |
| `staging/` | `stg_events` | Cleaned `raw_events`, typed. |
| `staging/` | `stg_assistant_messages` | **One row per `message_id`** — attributes `usage` from the *last* assistant line per message_id (`ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY ts DESC, byte_offset DESC) = 1`). This is where the double-counting is eliminated. |
| `staging/` | `stg_tool_calls` | Explodes `message.content[]` for assistant rows where `type='tool_use'`. One row per tool invocation. |
| `staging/` | `stg_tool_results` | Explodes `message.content[]` for user rows where `type='tool_result'`. One row per tool result, joined back to its `tool_use_id`. |
| `intermediate/` | `int_turns` | Pairs user prompt → assistant response (one assistant message_id = one turn). Carries the deduped `usage`. |
| `marts/` | `dim_sessions` | One row per session — first/last ts, agent, model, project (`cwd`), turn count, total cost. |
| `marts/` | `fact_turns` | One row per turn — tokens, cost, tool count, context_pct (from the *last* line of the turn). |
| `marts/` | `fact_model_calls` | One row per `message_id` — full token mix and `calculated_cost`. Built off `stg_assistant_messages`. |
| `marts/` | `fact_tool_executions` | One row per tool call. |
| `marts/` | `fact_daily_spend` | One row per `(tenant_id, date, agent, model)`. Drives the daily dashboard. |

**Sidechain handling:** `is_sidechain = TRUE` rows are included in `fact_model_calls` and `fact_daily_spend` (they cost real money) but excluded from `fact_turns.context_pct` of the parent session (they have their own context).

### 5.3 Pricing (`seeds/model_pricing.csv`)

| col | type | notes |
| --- | --- | --- |
| `tenant_id` | text | nullable; `NULL` = global default. Tenant override row wins when both exist. |
| `model` | text | exact id, e.g. `claude-opus-4-7` |
| `provider` | text | `anthropic`, `google`, `openai` |
| `cost_input_per_mtok` | numeric | $ per 1M input tokens |
| `cost_output_per_mtok` | numeric | $ per 1M output tokens (thinking billed here) |
| `cost_cache_write_5m_per_mtok` | numeric | matches `ephemeral_5m_input_tokens` |
| `cost_cache_write_1h_per_mtok` | numeric | matches `ephemeral_1h_input_tokens` |
| `cost_cache_read_per_mtok` | numeric | matches `cache_read_input_tokens` |
| `cost_batch_input_per_mtok` | numeric | nullable; reserved for Batch API in v0.5+ |
| `cost_batch_output_per_mtok` | numeric | nullable |
| `context_window_tokens` | integer | also used by the watcher for `context_pct` |
| `context_window_beta_flag` | text | nullable; e.g. `'context-1m-2025-08-07'` — different window when this beta is active |
| `tokenizer` | text | `anthropic`, `tiktoken-o200k`, `sentencepiece-gemini` — needed for cross-provider reconciliation |
| `valid_from` | date | |
| `valid_to` | date | nullable = current |

Cost in `fact_model_calls` is computed in dbt by joining the call timestamp against `[valid_from, coalesce(valid_to, DATE '9999-12-31')]`.

**Fail-loud rule:** a dbt `not_null` test on `fact_model_calls.calculated_cost` fails the build if no pricing row matched. A `coverage_test.sql` seed (a row with model `__never_match__` valid only for a known date) is included so CI verifies the test actually catches misses.

### 5.4 Compaction detection (best-effort)

⚠️ **v2 fix (no explicit compaction marker exists in JSONL).** Aura detects compaction heuristically in `int_turns`:
- Compute `prev_input_tokens` for the same session.
- If `input_tokens < 0.5 * prev_input_tokens` AND `prev_input_tokens > 50000`, flag `compaction_inferred = TRUE`.
- Surface this as a visual marker on the deep-dive timeline. It is **not** used in any cost or context % calculation.

If a future Claude Code version emits an explicit compaction event, the adapter will pick it up via the unknown-event handling and we add it cleanly.

---

## 6. Presentation — Streamlit only

Streamlit opens `aura_read.duckdb` in read-only mode. The watcher's snapshot worker writes a fresh copy every `snapshot_interval_seconds` (default 2) by issuing `PRAGMA force_checkpoint;` on `aura.duckdb`, then copying the file to `aura_read.duckdb.tmp`, then `os.replace()` to the final path (atomic on NTFS and POSIX). Streamlit opens a new read-only connection per query and notices the swap via mtime. `EXPORT DATABASE` / `IMPORT DATABASE` is the documented alternative but slower; we will benchmark in v0.1 and reconsider only if file-copy proves unreliable. See §9 #1.

### `Home`
- "Right now" card: most recently appended session — live `context_pct` (read from `raw_events` directly, the watcher has already computed it), session tokens, session cost. `st.fragment(run_every="2s")`.
- "Today" cards: spend, tokens, sessions, top model. Reads `fact_daily_spend` if available, **falls back to an inline SQL aggregate over `raw_events`** if `fact_daily_spend` doesn't exist yet (first-run / pre-dbt-build state).

### `Sessions`
- Searchable, filterable table of `dim_sessions`. Click → deep-dive: turn list with expandable tool calls, exact targets, tool outputs reconstructed from `raw_events.payload` via `json_extract`.

### `Trends`
- Spend over time (day / week / month) split by model, agent, project (`cwd`).
- Top edited projects/files (from `fact_tool_executions` where `tool_name in ('Edit', 'Write', 'NotebookEdit')`).
- Token mix: input / output / cache-write-5m / cache-write-1h / cache-read.

### Read-path discipline
- Live panels read `raw_events` and `ingest_checkpoints` only.
- Trends + daily read marts.
- `aura_read.duckdb` is the single file Streamlit touches.

---

## 7. Configuration

```toml
[tenant]
id = "local"

[watcher]
roots = [
  { agent = "claude", path = "/logs/claude" },
  # { agent = "gemini", path = "/logs/gemini" },
]
debounce_ms = 200
snapshot_interval_seconds = 2
redact_payload = false                # v0.1 default; SaaS will force true

[duckdb]
write_path = "/data/aura.duckdb"
read_path  = "/data/aura_read.duckdb"

[dbt]
run_interval_minutes = 60             # 0 disables

[ui]
timezone = "UTC"                      # display tz; storage stays UTC
live_refresh_seconds = 2
```

### Redaction (when `redact_payload = true`)
- Replace any value matching `(?i)(api[_-]?key|secret|token|password)[\"']?\s*[:=]\s*[\"']?[A-Za-z0-9_\-]{16,}` with `«REDACTED»`.
- Truncate any base64-looking blob > 200 chars to `<base64:N bytes>`.
- Applied at adapter time before `payload` is written. Token counts and computed cost are unaffected.

---

## 8. Phasing (MVP-first)

| Version | Scope | Notes |
| --- | --- | --- |
| **v0.1** | Watcher (Claude adapter), `raw_events`, `ingest_checkpoints`, snapshot worker, Streamlit `Home` with **live context_pct** (computed in watcher) and "today's spend" (computed from `raw_events` directly — no dbt yet). Redaction flag wired in. | ~2 days. No contradiction: context_pct is in the watcher, not in dbt. |
| **v0.2** | dbt project: pricing seed, staging (incl. message-id dedup + tool-call explode), `fact_daily_spend`. Hourly dbt timer in watcher. Streamlit `Trends` page reads marts. | ~2 days |
| **v0.3** | Full marts (`fact_turns`, `fact_model_calls`, `fact_tool_executions`, `dim_sessions`). Streamlit `Sessions` deep-dive with turn-by-turn replay + tool call expansion. Compaction heuristic. | ~3 days |
| **v0.4** | Gemini adapter + provider-aware pricing rows. Multi-agent comparisons in `Trends`. | ~1 day |
| **v0.5** | Anthropic Workbench CSV import (separate `fact_cloud_daily_spend`, joined on `(date, model)` in the daily dashboard). Note: there is no per-token Anthropic Console dashboard for personal Pro/Max plans — feature is org-API-key gated. | ~2 days, feasibility-checked first |
| **v0.6+** | Optional LLM-based session categorization. Column added only when the feature is built. | TBD |

---

## 9. Open questions / non-decisions

1. **`EXPORT DATABASE` vs in-place file copy for the snapshot:** `EXPORT DATABASE` to a directory + `IMPORT DATABASE` is officially supported but slower; file copy works as long as DuckDB has flushed. v0.1 will test both; default is file copy with `PRAGMA force_checkpoint;` before copy.
2. **Snapshot atomicity on Windows:** writing to `aura_read.duckdb.tmp` and `os.replace()` is atomic on NTFS for the close-then-rename case. Confirm Streamlit's file handle releases between reads (we open per-query, not persistent).
3. **`redact_payload` retroactive:** the `aura-cli redact-existing` command must scan `raw_events.payload` and apply the same regex. Cheap, but irreversible — should require `--confirm`.
4. **Token reconciliation across providers:** the `tokenizer` column is in the seed but we don't yet have a cross-tokenizer normalization story. Not blocking v0.4; document the gap.

---

## 10. Repo layout

```
AURA/
├── aura.toml                        # user config; examples/ has a template
├── docker-compose.yml
├── watcher/
│   ├── Dockerfile
│   ├── pyproject.toml
│   ├── src/aura_watcher/
│   │   ├── main.py
│   │   ├── checkpoint.py
│   │   ├── snapshot.py              # snapshot worker
│   │   ├── redact.py
│   │   ├── adapters/
│   │   │   ├── base.py
│   │   │   └── claude.py
│   │   └── duckdb_writer.py
│   └── tests/                       # incl. fixture .jsonl files
├── dbt/
│   ├── dbt_project.yml
│   ├── profiles.yml                 # duckdb adapter
│   ├── seeds/model_pricing.csv
│   ├── seeds/coverage_test.csv      # CI guard for fail-loud pricing
│   └── models/{staging,intermediate,marts}/
├── streamlit/
│   ├── Dockerfile
│   ├── app.py
│   └── pages/
│       ├── 1_Sessions.py
│       └── 2_Trends.py
├── .claude/
│   └── agents/                      # see §11; created during implementation
├── CLAUDE.md                        # project memory, style modelled on crosshire; defines cordial-mode
└── docs/superpowers/specs/2026-05-23-aura-design.md
```

---

## 11. Agents (to be authored during implementation)

Style **mirrors crosshire** — YAML frontmatter (`name`, `description`, `tools`, `model`), Karpathy-tailored sections with concrete Aura-specific examples (JSONL adapter pitfalls, dbt SCD on pricing, etc.). Two project-wide rules live in `CLAUDE.md`, not in each agent file:

> **Cordial mode (project-wide):** Before any change that touches more than one file, alters the DuckDB schema, deletes data, modifies a dbt model, or touches `model_pricing.csv`, summarize the intended change and wait for user confirmation. Trivial edits proceed.

### 11.1 Runner routing — keep the main context small

**Rationale (verbatim from the user, captured here so the design intent survives):**
> "When you pull 40,000 tokens into the main context, you aren't just paying for those tokens once; you pay for them on every subsequent turn because the entire history is re-submitted. Spawning a subagent to compress those 40k tokens into a 400-token summary is exactly what the Agent tool is built for. It isolates the noise and preserves the main agent's working memory."

This drives the routing:

```
TRIVIAL request           → MAIN handles directly
NON-TRIVIAL request       → MAIN dispatches to `runner` (Sonnet)
deep specialist work      → `runner` dispatches to a specialist
                            (data-engineer | dbt-expert | frontend-engineer | code-reviewer)
```

`runner` is the **default delegate for any substantive work** in this project. CLAUDE.md is auto-loaded at every session start, and it tells MAIN to follow this routing. There is no hook required — the routing is policy in CLAUDE.md, applied by MAIN reading it.

**Definition of "trivial":** a single-file edit, a one-shot read, a clarifying question. Anything that requires multiple tool calls, schema/SQL reasoning, or cross-file changes is non-trivial.

### 11.2 Runner return contract

The runner deliberately does **not** over-compress. Crosshire-style ultra-terse 400-token summaries are too lossy for this project — they invite bad decisions in MAIN. Instead:

- Target ~800–1500 tokens for a runner return, structured for skimming.
- Always include a `confidence` field: `H` / `M` / `L` plus a one-line reason.
- Always include a `verified` line (what actually ran / was checked) and an `uncertain` line (what wasn't).
- If MAIN judges the confidence too low or the summary too thin to act on safely, **re-run the runner with a more targeted prompt** rather than guessing. This is cheaper than acting on a bad summary.

Concretely, every runner reply ends with:

```
+ confidence: <H|M|L> — <one line>
+ verified:   <what ran / was read>
+ uncertain:  <what wasn't checked>
+ next:       <suggested next step, if any>
```

### 11.3 Initial roster

| Agent | Model | Surface |
| --- | --- | --- |
| `runner` | sonnet | Default delegate; orchestrates specialists; produces detailed-but-bounded summaries (§11.2) |
| `data-engineer` | sonnet | `watcher/` — JSONL adapters, DuckDB writer, checkpoint, snapshot, redaction |
| `dbt-expert` | sonnet | `dbt/` — models, pricing seed, fail-loud tests |
| `frontend-engineer` | sonnet | `streamlit/` — pages, fragments, charts |
| `code-reviewer` | sonnet | All — diff review against this spec |

Opus is reserved for explicit user request (strategic judgment, deep design work). Haiku is reserved for mechanical bulk work (mass renames, doc reformatting).

---

## 12. Success criteria

Aura is "done at v0.3" when:

1. **Real-time freshness.** Starting Claude Code and editing a file shows a new row in `raw_events` within 2 seconds (measured by `SELECT max(ts) FROM raw_events`).
2. **No double-counting.** `SUM(input_tokens + output_tokens) FROM fact_model_calls` for a hand-picked session equals the sum of unique `message.id` usages in the raw JSONL, verified by a fixture-based dbt test.
3. **Context % matches Claude Code's status bar** within ±2 percentage points on three sampled live sessions.
4. **Live UI updates.** The Streamlit `Home` panel reflects new turns within 4 s (snapshot 2 s + render 2 s).
5. **Crash safety.** Killing and restarting the watcher loses zero rows and produces zero duplicates (idempotency test: re-run backfill on unchanged DuckDB → zero new rows).
6. **Clean teardown / startup.** `docker compose down && docker compose up` returns to identical state with no manual steps.
7. **Cost magnitude check.** Total cost over the last 7 days is within ±10 % of any independent reference the user can provide (e.g. Workbench CSV export if available). "Within 2 %" was dropped from v1 of this doc — Anthropic does not publish a per-token dashboard for personal plans, so the tight bound was not testable. ±10 % is honest.
