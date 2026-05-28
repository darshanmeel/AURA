# Agents — list view

**URL:** `/agents`  
**Primary range:** 7d  
**Variants:** all-time

## What this screen shows

A ranked roster of Claude Code subagents (e.g., `code-reviewer`, `frontend-engineer`) that have written events. Each row is one agent × app assignment, showing cost, session count, turn count, and tool calls. "main" is the orchestrator session, not a delegated subagent. The page answers: _What agents ran, where, and at what cost?_

## Layout & components

- **Masthead strip** — heading, unique agent count, total app assignments, date range filter, aggregate cost pill
- **Stats block** — 3 columns (unique agents, app assignments, total cost)
- **Agents ledger** — sortable table with name, app, project, sessions, turns, tools, cost, and cost-share bar
- **Range filter** — 7d (primary), 30d, 90d, all-time

## Data sources

| Component | Query | Mart/Fact |
|---|---|---|
| Lifetime (no range) | `getAllAgents()` | `dim_agents` |
| Ranged (7d/30d/90d/all) | `getAllAgents(since)` | `int_entity_spend` (agent grain) |

**Note:** Lifetime uses `dim_agents` (app assignments preserved); ranged uses `int_entity_spend` (aggregates to agent, nulls app/project). See query comments in `frontend/lib/queries/agents.ts`.

## How to read it

- **"main" dominates** — it's the top-level orchestrator, not a delegated subagent. High cost is normal.
- **Agent × app rows** — same agent can appear multiple times (one row per app it ran in); "· 3 apps" label shows multi-app agents.
- **Cost is cumulative** — sum of all model calls where `int_event_agent.agent_resolved = agent_name`.
- **Share bar** — normalized to max row cost for visual comparison.
- **"unknown" rows** — events the resolver couldn't attribute (rare, indicates parsing or schema gaps).

## Edge cases / empty states

- **No data in range** — only "main" appears (orchestrator always present).
- **Agent renamed** — may appear in two rows if identity changed during range (e.g., `frontend-engineer` → `ui-engineer`).
- **New agent dispatch** — agent name added to roster once first turn completes and dbt runs (typically within 5 minutes).
- **Ranged view loses app precision** — `int_entity_spend` aggregates to agent grain; app_id and project_id are NULL for ranged queries.

## Related screens

- [Agent detail](./agent-detail.md) — dive into single agent's models, sessions, files, collaborators
- [Session detail — Agents tab](./session-detail.md) — shows which agents participated in a session
- [Apps list](./apps-list.md) — agents grouped by their deployment app

## Screenshots

- **7d (primary):** ![agents-list 7d](./agents-list.png)
- **All-time:** ![agents-list all](./agents-list-all.png)
