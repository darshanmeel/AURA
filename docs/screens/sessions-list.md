# Sessions — list view

**URL:** `/sessions`  
**Primary range:** 7d  
**Variants captured:** today

## What this screen shows

The complete ledger of all Claude Code sessions, sortable by date, cost, turns, or tokens. Displays session metadata (person, app, agent, model), execution summary (turns, commits, cost), and a prompt preview with git branch info. Click any row to open the per-turn ledger and detailed analysis.

## Layout & components

- **Range filter** — `today`, `7d` (default), `30d`, `all` — updates URL search param
- **Session count pill** — total matching filters; shows subset if truncated (>200 rows)
- **Search input** — filters by title, session ID, or cwd (path); case-insensitive substring
- **Provider select** — `All`, `Anthropic`, `Google` 
- **Status select** — `All`, `Active` (no `end_ts`), `Completed` (has `end_ts`)
- **Sort select** — `Newest first`, `By cost`, `By turns`, `By tokens`
- **Stat strip** — Sessions count, total cost (USD), aggregate turns, aggregate commits
- **Sessions table** — 10 columns:
  - **Started** — date + time + duration if completed; gray text
  - **Person** — person_name or "—"
  - **App** — app_id or last path segment (cwd); blue link
  - **Agent** — agent name or "—"; blue link
  - **Title · Prompt** — truncated session_title (200 chars) with session_id[:8] + git_branch below; clickable link
  - **Model** — model pill (color-coded: Claude3.5/Opus/Sonnet/Haiku)
  - **Turns** — turn_count; numeric
  - **Commits** — commits; numeric
  - **Cost** — total_cost in USD; strong (bold); numeric
  - **→** — row chevron (visual affordance for clickability)

## Data sources

| Component | Query | Mart / table |
|---|---|---|
| Sessions list | `getSessions()` | `dim_sessions` |
| Stats strip | `getSessionsStats()` | `dim_sessions` (aggregate) |
| App lookup | Left join `dim_apps` on cwd | `dim_apps` |

**Page size:** 50 rows (reserved for pagination; currently LIMIT 200 for stats cap).

## How to read it

Each row is a single session:

- **Cost** is the sum of all turns' `calculated_cost` (input tokens × per-model price + output tokens × per-model price per `model_pricing.csv`).
- **Turns** is the count of assistant events (not user events); each turn may include multiple tool calls.
- **Commits** is aggregated from `session_meta.commits` (git commits made during the session).
- **Stat strip totals** use server-side sums from `getSessionsStats()`, not just the displayed subset (accurate even if >200 rows exist).
- **Started** time and **duration** help identify when the work occurred. Duration only shows for completed sessions (where `end_ts` is not null).

## Edge cases / empty states

- **No sessions in range** — table shows `No sessions match these filters.` empty state (gray text in single row, colSpan=10)
- **Active sessions** — no `end_ts`, so duration shows blank (only time + no duration suffix)
- **No app_id** — falls back to cwd path last segment (e.g. "AURA" from "D:/darshanmeel/AURA")
- **No git_branch** — omits the git_branch line below session_id[:8]
- **Fetch error** — if DuckDB is not ready, shows `Could not load sessions — the database may not be ready yet.` message

## Related screens

- [Session detail](./session-detail.md) — `/sessions/:id` per-turn ledger and analysis
- [Apps](./apps-list.md) — `/apps` app-level rollup
- [Observability](./observability.md) — `/observability` system health + medallion counts

## Screenshots

- 7d: ![](./sessions-list.png)
- Today: ![](./sessions-list-today.png)
