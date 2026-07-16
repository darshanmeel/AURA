# AURA — Operator's Overview

A field guide to the AURA dashboard, written from the most recent screenshots
and the underlying data model. Use this as the entry point; each screen has
its own deep-dive file in this directory, and [HOW-IT-WORKS.md](./HOW-IT-WORKS.md)
covers the architecture end-to-end.

> **What AURA is** — a local-first analytics tool that ingests Claude Code
> JSONL transcripts (`~/.claude/projects/**/*.jsonl`) into DuckDB, aggregates
> them with dbt every 5 minutes, and surfaces the result through a Next.js
> dashboard at http://localhost:3000.

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
            ▼  watchdog poller + claude.py adapter
    +────────────────+
    │  watcher       │  parses events / skills / MCPs / redacts secrets
    +────────────────+
            │
            ▼  INSERT ... ON CONFLICT DO NOTHING
    +────────────────────────────────────+
    │  raw_events          (bronze)      │  one row per JSONL event
    │  session_meta        (bronze)      │  one row per session
    │  raw_session_skills  (bronze)      │  skills loaded per session
    │  raw_session_mcps    (bronze)      │  MCP servers loaded per session
    +────────────────────────────────────+
            │
            ▼  dbt run every 5 minutes
    +────────────────────────────────────+
    │  stg_* (silver)      per-event-type views
    │  int_* (silver)      turns, agent-resolved, prompts
    +────────────────────────────────────+
            │
            ▼
    +────────────────────────────────────+
    │  fact_* + dim_* (gold)             │
    │  fact_turns / fact_prompts /       │
    │  fact_model_calls /                │
    │  fact_tool_executions /            │
    │  dim_sessions / dim_apps /         │
    │  dim_agents / dim_people /         │
    │  fact_daily_spend /                │
    │  fact_hourly_activity /            │
    │  int_entity_spend (universal pivot)│
    +────────────────────────────────────+
            │
            ▼  read-only snapshot every 30s
    +────────────────────────────────────+
    │  Next.js frontend                  │
    │  server components query DuckDB    │
    │  SVG charts, no API except         │
    │  /api/observability polling        │
    +────────────────────────────────────+
```

Backfill and dbt are **independent stages**. dbt runs every 5 minutes on
whatever exists in `raw_events` — it does not wait for backfill to finish.
This is why the dashboard "fills in" progressively after a fresh start.
For the deeper architecture story, see [HOW-IT-WORKS.md](./HOW-IT-WORKS.md).

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
   + 9 tabs    + skills  + skills                    in its parent list)
              + MCPs    + MCPs

                         Observability  (separate "pipeline" surface)
```

7 top-level routes. Four of them (`/sessions`, `/apps`, `/agents`,
`/people`) drill into `/<route>/<id>`. `/tokens`, `/errors`,
`/observability` are leaf pages. `/` is the dashboard.

---

## The 13 captured screens

Per-screen docs sit beside this file. The table below frames *why each screen
exists* — when an operator would open it.

| When you want to… | Open | Notes |
|---|---|---|
| See the headline for a range | [Dashboard](./dashboard.md) | 6 KPIs, token chart, ledgers, heatmap, Skills & MCPs bar at bottom |
| List every session in a range | [Sessions](./sessions-list.md) | now with 🧩 + ⚡ count columns, multi-agent display |
| Inspect one session end-to-end | [Session detail](./session-detail.md) | 9 tabs, agent strip in masthead, visible Skills & MCPs section |
| Compare apps (working dirs) | [Apps](./apps-list.md) | one row per cwd-rooted project |
| Drill into one app | [App detail](./app-detail.md) | sessions, agents, files + Skills & MCPs panel |
| Compare subagents | [Agents](./agents-list.md) | real subagent attribution + footnote on the `main` bucket |
| Drill into one subagent | [Agent detail](./agent-detail.md) | + Skills & MCPs the agent loads (via int_event_agent CTE) |
| See operators | [People](./people-list.md) | now populated (311/349 sessions resolved) |
| Drill into one person | [Person detail](./person-detail.md) | sessions / apps / agents per operator |
| Audit failures | [Errors](./errors-list.md) | tool errors + watcher errors merged, timestamps with date |
| Check pipeline health | [Observability](./observability.md) | live, 10s polling, dbt cycle state |
| Slice token spend deeper | [Tokens](./tokens-page.md) | by type / provider / model / agent — real subagents now |
| See the 404 chrome | [404](./nav-404.md) | for unknown sessions / apps / agents |

---

## Conventions you'll see on every screen

### Range filter
`today` · `7d` · `30d` · `all`. Server reads `searchParams.range`, maps it
to a SQL `WHERE date >= 'YYYY-MM-DD'`. **Two range branches** appear in many
queries:

- **Lifetime path** (no range) → reads from dim/fact marts (richest data;
  agent-by-app cross-tabs survive).
- **Ranged path** → reads from `int_entity_spend` (pre-aggregated, faster,
  but drops some cross-tab dimensions to NULL).

That's why some columns blank out when you switch from "all" to "7d".

### Cost numbers
**One formula everywhere.** All `$` values resolve to `total_cost` derived
from `fact_model_calls` via `model_pricing.csv`. The same dollar appears
on the dashboard, the sessions list, the session detail. If two screens
disagree, that's a bug (see memory: cost reconciliation).

### Token chart palette
The stacked bars in the Tokens chart use a fixed palette:

| Type | Colour | Cost note |
|---|---|---|
| Input | teal `#4caf82` | cheapest |
| Output | gold `#e8c547` | priciest per-token (~5× input) |
| Cache 1h | orange `#ef8232` | expensive on write |
| Cache 5m | violet `#c46acc` | moderate on write |
| Cache read | slate `#6b8aa8` | cheap, usually largest volume |

### Direction colours (Session detail → Messages tab)
A turn is classified by:

- **human** — USER ↔ CLAUDE direct conversation → green `👤`
- **sidechain** — `is_sidechain=true` Task-tool dispatch → orange `🤖`
- **orchestrated** — text-prefix patterns like `SendMessage to:`, `SCOPE
  EXPANSION`, `You are dispatched…`, etc. → amber `⚡`

### Agent attribution
- `fact_model_calls.agent` is overridden in dbt by
  `int_event_agent.agent_resolved`, so subagents (technical-writer, code-reviewer,
  …) appear with real costs instead of one giant `claude` bucket.
- `main` is the catch-all for orchestrator events + sessions launched
  directly with `claude --agent <name>` (which we can't recover after
  the fact — see the agents page footnote).

### Skills & MCPs surface
- **Per-session**: chips at masthead (count) + visible chip list section
  above tabs (names).
- **Per-app**: "Skills & MCPs in this app" panel at the bottom of /apps/[id].
- **Per-agent**: "Skills & MCPs this agent loads" panel at the bottom of
  /agents/[name]. Queries use `int_event_agent.agent_resolved` so the
  agent's full session set is honoured (not just the mode).
- **Dashboard**: top-10 lists for both at the very bottom.

---

## Data lineage cheat sheet

| Mart / table | One row per | Built from |
|---|---|---|
| `dim_sessions` | session | `fact_turns` + `fact_git_commands` + `agent_per_session` + `session_meta` + `raw_session_skills/mcps` |
| `dim_apps` | working directory | `int_app_cwd_lookup` rollup of `fact_session_files`, sessions, costs |
| `dim_projects` | git project root | aggregates over `dim_apps.project_id` |
| `dim_agents` | resolved agent name × app | `int_event_agent` + `fact_turns` |
| `dim_people` | OS user / configured person | `session_meta` |
| `fact_turns` | per-turn cost | `stg_assistant_messages` + `stg_tool_results` |
| `fact_prompts` | external user prompt | `stg_events` filtered to userType=external + non-tool-result content |
| `fact_tool_executions` | tool call | `stg_tool_calls` + `stg_tool_results` |
| `fact_model_calls` | model invocation | `stg_assistant_messages` with agent override from `int_event_agent` |
| `fact_daily_spend` | (date, model, provider) | aggregation of `fact_model_calls` |
| `int_entity_spend` | (date, entity_type, entity_id) | universal "spend per X per day" pivot |
| `fact_git_commands` | parsed `git` invocation | `fact_tool_executions` Bash filter |
| `raw_session_skills` | (session, skill_name) | watcher parses `invoked_skills` attachment |
| `raw_session_mcps` | (session, mcp_server) | watcher parses `mcp_instructions_delta` |
| `watcher_errors` | parser / lock failure | written directly by the watcher |

---

## Known gaps & edge cases

- **38 / 349 sessions still show 'Unknown' person**: their JSONL file isn't
  in `~/.claude/projects/` anymore (deleted or moved). Backfill can't write
  session_meta without the file.
- **Skills + MCPs are session-level events**. Only ~16/349 sessions actually
  load any skill (Claude Code attaches them lazily). Most session detail
  pages legitimately have no Skills & MCPs section.
- **`main` dominates Agents list.** It aggregates the orchestrator plus
  every `claude --agent <name>` top-level launch (e.g. `learn-runner`)
  whose agent identity can't be recovered from a structured JSONL field.
- **Hourly token chart only on `range=today`.** Other ranges always
  bucket by day. The legend and X-axis switch automatically.
- **Errored prompt count ≠ error row count.** A prompt with two failed
  tool calls is one "errored prompt", two "errors caught".
- **Read-DB snapshots can briefly corrupt** if the watcher writes mid-copy.
  Recovery: stop the watcher, `FORCE CHECKPOINT` the write DB, copy it to
  `/data/read/aura.duckdb`, restart. The frontend's inode cache auto-refreshes.

---

## Refreshing this documentation

The screenshots and per-screen docs were captured by 13 Haiku Playwright
agents running in parallel. To regenerate, dispatch the same fleet again —
each agent's brief is self-contained and includes the Playwright Node
snippet.

For deeper architecture detail (watcher internals, dbt graph, queries,
known races), see [HOW-IT-WORKS.md](./HOW-IT-WORKS.md).
