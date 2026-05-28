# AURA — Operator's Overview

A field guide to the AURA dashboard, written from the captured screenshots
and the underlying data model. Use this as the entry point; each screen
has its own deep-dive file in this directory.

> **What AURA is** — a local-first analytics tool that ingests Claude Code
> JSONL transcripts (`~/.claude/projects/**/*.jsonl`) into DuckDB,
> aggregates them with hourly dbt rollups, and surfaces the result through
> a Next.js dashboard. Watcher and dbt run in Docker; the dashboard is at
> http://localhost:3000.

---

## The three questions AURA answers

1. **What did the agents do today?**
   → Dashboard, Sessions list, Errors. Range = today / 7d.

2. **Where is the money going?**
   → Dashboard hero + token chart, Tokens drill-down, App / Agent / Person
   detail pages. Range = 7d / 30d / all.

3. **Is the pipeline healthy?**
   → Observability. No range — always live.

---

## Architecture in one diagram

```
~/.claude/projects/**/*.jsonl  (Claude Code logs on the host)
            │
            ▼  watchdog polling adapter (claude.py)
    +────────────────+
    │  watcher       │  parses events, skills, MCPs, redacts secrets
    +────────────────+
            │
            ▼  INSERT ... ON CONFLICT DO NOTHING
    +────────────────+
    │  raw_events    │  bronze (one row per JSONL event)
    │  session_meta  │  bronze (one row per session)
    │  raw_session_  │  bronze (skills + MCP servers)
    │  skills / mcps │
    +────────────────+
            │
            ▼  dbt run every 5 minutes
    +────────────────+
    │  stg_* models  │  silver (per-event-type views)
    │  int_* models  │  silver (turns, agent-resolved, prompts)
    +────────────────+
            │
            ▼
    +────────────────+
    │  fact_* + dim_*│  gold (turns, prompts, tool execs, sessions, apps,
    │  marts         │        agents, people, daily spend, hourly activity)
    +────────────────+
            │
            ▼  read-only snapshot (`/data/read/aura.duckdb`)
    +────────────────+
    │  Next.js       │  server components query DuckDB; SVG charts;
    │  frontend      │  no API layer except /api/observability polling
    +────────────────+
```

Backfill and dbt are **independent stages**. dbt runs every 5 minutes on
whatever exists in `raw_events` — it does not wait for backfill to finish.
This is why the dashboard "fills in" progressively after a fresh start.

---

## Navigation map

```
                           Dashboard  (home, the only "summary" page)
                              │
        ┌──────────┬──────────┼──────────┬──────────┬──────────┐
        ▼          ▼          ▼          ▼          ▼          ▼
    Sessions    Apps      Agents     People     Errors    Tokens
        │          │          │          │
        ▼          ▼          ▼          ▼
   Session     App       Agent      Person          (drill-downs;
   detail      detail    detail     detail           each is one row
   + 9 tabs                                          in the parent list)

                          Observability  (separate "pipeline" surface)
```

Top-level nav: 7 routes. Three of them (`/sessions`, `/apps`, `/agents`,
`/people`) drill into `/<route>/<id>`. `/tokens` and `/errors` and
`/observability` are leaf pages. `/` is the dashboard.

---

## The 13 captured screens

Per-screen docs sit beside this file. The table below frames *why each
screen exists* — when an operator would open it.

| When you want to… | Open | Notes |
|---|---|---|
| See the headline for a range | [Dashboard](./dashboard.md) | 6 KPIs, token chart, 4 ledgers, 1 heatmap |
| List every session in a range | [Sessions](./sessions-list.md) | filterable, searchable |
| Inspect one session end-to-end | [Session detail](./session-detail.md) | 9 tabs — Messages = direction-coloured transcript |
| Compare apps (working dirs) | [Apps](./apps-list.md) | one row per cwd-rooted project |
| Drill into one app | [App detail](./app-detail.md) | sessions, agents, files for one cwd |
| Compare subagents | [Agents](./agents-list.md) | `main` = orchestrator, others = delegates |
| Drill into one subagent | [Agent detail](./agent-detail.md) | which apps & people use it, cost driven |
| See operators | [People](./people-list.md) | currently 1 row (see "Known gaps" below) |
| Drill into one person | [Person detail](./person-detail.md) | sessions / apps / agents per operator |
| Audit failures | [Errors](./errors-list.md) | tool errors + watcher errors merged |
| Check pipeline health | [Observability](./observability.md) | live, 10s polling, dbt cycle state |
| Slice token spend deeper | [Tokens](./tokens-page.md) | by type / provider / model / agent |
| See the 404 chrome | [404](./nav-404.md) | for unknown sessions / apps / agents |

---

## Conventions you'll see on every screen

### Range filter
`today` · `7d` · `30d` · `all`. Server reads it from `searchParams.range`,
maps to a SQL `WHERE date >= 'YYYY-MM-DD'`. **Two range branches** in many
queries:

- **Lifetime path** (no range) → reads from dim/fact marts (richest data,
  e.g. agent-by-app cross-tabs survive).
- **Ranged path** → reads from `int_entity_spend` (pre-aggregated, faster,
  but drops some cross-tab dimensions to NULL).

That's why some columns blank out when you switch from "all" to "7d".

### Cost numbers
**One formula everywhere.** All `$` values resolve to `total_cost` derived
from `fact_model_calls` via `model_pricing.csv`. The same dollar appears
on the dashboard, the sessions list, the session detail. If two screens
disagree, that's a bug (see memory: cost reconciliation).

### Token chart palette
The stacked bars in `Tokens over time` use a fixed palette:

| Type | Colour | Cost note |
|---|---|---|
| Input | teal `#4caf82` | cheapest |
| Output | gold `#e8c547` | priciest (~5× input) |
| Cache 1h | orange `#ef8232` | expensive on write |
| Cache 5m | violet `#c46acc` | moderate on write |
| Cache read | slate `#6b8aa8` | cheap, usually largest volume |

Earlier dashboards used cream/tan vars (`--ink`, `--ink-2`, `--accent-2`)
which all rendered nearly identical against the paper background. Fixed.

### Direction colours (Session detail → Messages tab)
A turn is classified by:

- **human** — USER ↔ CLAUDE direct conversation → green `👤`
- **sidechain** — `is_sidechain=true` Task-tool dispatch → orange `🤖`
- **orchestrated** — text-prefix patterns like `SendMessage to:`, `SCOPE
  EXPANSION`, `You are dispatched…`, etc. → amber `⚡`

The text-prefix classifier exists because not every orchestrator hand-off
sets `is_sidechain` (parent orchestrators are still `is_sidechain=false`
when they brief a peer agent). Both signals are needed.

### Overkill detection
On the Prompts tab of session-detail, "OVERKILL" badges flag prompts where
the model class is oversized for the prompt's complexity (heuristic in the
prompts query layer). Useful for tuning per-app model assignments.

---

## Data lineage cheat sheet

| Mart / table | One row per | Built from |
|---|---|---|
| `dim_sessions` | session | `fact_turns` + `fact_git_commands` + `agent_per_session` + `session_meta` + `raw_session_skills/mcps` |
| `dim_apps` | working directory | `int_app_cwd_lookup` rollup of `fact_session_files`, sessions, costs |
| `dim_projects` | git project root | aggregates over `dim_apps.project_id` |
| `dim_agents` | resolved agent name | `int_event_agent` + `fact_turns` |
| `dim_people` | OS user / configured person | `session_meta` (after the backfill fix) |
| `fact_turns` | per-turn cost | `stg_assistant_messages` + `stg_tool_results` |
| `fact_prompts` | external user prompt | `stg_events` filtered to userType=external + non-tool-result content |
| `fact_tool_executions` | tool call | `stg_tool_calls` + `stg_tool_results` |
| `fact_model_calls` | model invocation | `stg_assistant_messages` with token + cost breakdown |
| `fact_daily_spend` | (date, model, provider) | aggregation of `fact_model_calls` |
| `int_entity_spend` | (date, entity_type, entity_id) | the universal "spend per X per day" pivot |
| `fact_git_commands` | parsed `git` invocation | `fact_tool_executions` Bash filter |
| `raw_session_skills` | (session, skill_name) | watcher parses `invoked_skills` attachment |
| `raw_session_mcps` | (session, mcp_server) | watcher parses `mcp_instructions_delta` |
| `watcher_errors` | parser / lock failure | written directly by the watcher |

---

## Known gaps & edge cases

- **People — historic = "unknown".** Sessions backfilled before the
  session_meta fix did not get rows. The fix (commit `be81568`) holds
  `_snapshot_lock` during the bulk backfill and respects
  `AURA_DEFAULT_PERSON_ID` / `AURA_DEFAULT_PERSON_NAME` env vars so the
  developer's identity overrides the container's `root` user. After the
  next watcher restart, all sessions resolve to the configured person.
- **Skills — historic = 0.** `raw_session_skills` was empty until the
  parser was taught the actual attachment type (`invoked_skills`, not
  `skill_listing`). Fixed in commit `7509c82`; backfill repopulated.
- **`main` dominates Agents list.** That's the orchestrator session, not
  a delegated subagent. It's expected to top the chart in most ranges.
- **Hourly token chart only on `range=today`.** Other ranges always
  bucket by day. The legend and X-axis switch automatically.
- **Active sessions show no `end_ts`.** Status column reads `active` until
  the JSONL stops growing.
- **Errored prompt count ≠ error row count.** A prompt with two failed
  tool calls is one "errored prompt", two "errors caught".

---

## How to refresh this documentation

The screenshots and per-screen docs were captured by 13 Haiku Playwright
agents running in parallel. To regenerate:

1. Make sure the local stack is up (`docker compose ps` shows both
   containers healthy).
2. Verify representative data is present:
   - `docker exec aura-watcher-1 python -c "import duckdb; c =
     duckdb.connect('/data/read/aura.duckdb', read_only=True); print(
     c.execute('SELECT COUNT(*) FROM dim_sessions').fetchone())"`
3. Re-dispatch the Haiku fleet (the prompt template per screen is
   embedded in this conversation's history; each agent's brief is
   self-contained and includes the Playwright Node snippet).

Or, for a single screen, copy the Playwright snippet out of the per-screen
doc and run `node` directly.

---

## Cross-references

- [Screen index (README)](./README.md)
- [Repo CLAUDE.md](../../CLAUDE.md) — agent routing + cordial-mode policy
- [Per-screen docs](.) — 13 files, one per route
