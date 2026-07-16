# Aura — Number Source Map

Every number displayed on every screen, its source table, and its exact formula.
Written against the live codebase — last verified 2026-05-28.

> **North-star rule:** numbers that represent the same concept across screens must come from
> the same table and the same formula. Deviations are noted explicitly.

---

## Shared definitions

| Term | Meaning |
|------|---------|
| **turn** | One LLM API call → one row in `fact_turns` / `stg_assistant_messages`. One human prompt typically triggers many turns (tool-use iterations). |
| **prompt** | One external human message → one row in `fact_prompts`. Filter: `userType='external'`, `isMeta != 'true'`, string content (not `tool_result` array). Subagent sessions can have 0 prompts. |
| **session cost** | `SUM(fact_model_calls.calculated_cost)` rolled into `dim_sessions.total_cost`. |
| **daily cost** | `fact_daily_spend.daily_cost` = `SUM(fact_model_calls.calculated_cost)` grouped by `CAST(ts AS DATE)`. Uses **event timestamp**, not session start date. |
| **lifetime view** | No date filter — reads the pre-built mart (`dim_apps`, `dim_agents`, `dim_people`). |
| **range view** | Date filter active (1d / 7d / 30d) — reads `int_entity_spend` (daily-grain pre-agg). |
| **`since`** | The date string (e.g. `2026-05-21`) derived from the selected range. |

### Cost formula (single source of truth)

```
calculated_cost = input_tokens         × input_rate
                + output_tokens        × output_rate
                + ephemeral_5m_tokens  × cache_write_rate_5m
                + ephemeral_1h_tokens  × cache_write_rate_1h
                + cache_read_tokens    × cache_read_rate
```

Rates come from the `model_pricing` seed, joined in `fact_model_calls`.

### Source-specific cost: `sdk_trace` sessions (verbatim)

Sessions ingested from external Agent SDK traces (`raw_events.source = 'sdk_trace'`;
see HOW-IT-WORKS § "SDK agent traces") do **not** use the token-pricing formula
above. Their cost is taken **verbatim** from the SDK `result` event's
`total_cost_usd`, carried on `raw_events.reported_cost_usd` and short-circuited in
`fact_model_calls.calculated_cost`:

```
calculated_cost = CASE
    WHEN source = 'sdk_trace' THEN COALESCE(reported_cost_usd, 0)  -- verbatim, from result.total_cost_usd
    ELSE  (token-pricing formula above)
END
```

| Display | Table | Formula |
|---------|-------|---------|
| Session cost (`sdk_trace`) | `fact_model_calls` → `dim_sessions.total_cost` | `SUM(calculated_cost)` where the sdk_trace arm returns `reported_cost_usd` verbatim |

The verbatim total rides on a single assistant turn — the `result` event is merged
onto the final `message` turn by `message_id`, and earlier turns in the same
session COALESCE to `0` — so `SUM(fact_model_calls.calculated_cost)` over the
session equals the SDK-reported `total_cost_usd` exactly (verified: a 3-message run
with `total_cost_usd=0.9999` yields turns `[0, 0, 0.9999]`, sum `0.9999`). Because
`fact_daily_spend` and `int_entity_spend` both aggregate
`fact_model_calls.calculated_cost`, the **dashboard hero**, daily chart,
providers/models panels, and every entity rollup include sdk_trace spend
automatically and reconcile to the same total — no separate path, no double count.

**Timestamp anchoring (`sdk_trace`):** SDK traces carry only `t` (seconds from run
start), no wall-clock. `raw_events.ts` is anchored as `file_mtime + t` —
approximate (mtime is the file's last-write time) but monotonic within a settled
file. Date-bucketed cost (`CAST(ts AS DATE)`) is therefore attributed to the trace
file's mtime date.

### Run-outcome status (`session_status`)

`dim_sessions.session_status` ∈ {`completed`, `budget_killed`, `interrupted`,
`error`, `unknown`}, derived in dbt from `raw_events` events (no `session_meta`
write path — consistent with the existing dbt-derived `status` column):

| Source | Derivation (in `dim_sessions`, CTE `sdk_run_meta`) |
|--------|-----------|
| `sdk_trace` | `result.raw.subtype='error_max_turns'` → `budget_killed`; else `result.raw.is_error='true'` → `error`; else an `interrupted` event present → `interrupted`; else `run_end.completed='true'` → `completed`; else `run_end.completed='false'` → `interrupted`; else `unknown` |
| `claude` | best-effort: `turn_count > 0` → `completed`, else `unknown` |

| Display | Table | Formula |
|---------|-------|---------|
| Status pill (`/sessions` row + session-detail header) | `dim_sessions.session_status` | verbatim |
| `turns_used` (sdk_trace only) | `dim_sessions.turns_used` | `run_end.assistant_turns` (fallback `turn_count`); NULL for claude |
| `max_turns` (sdk_trace only) | `dim_sessions.max_turns` | `run_start.max_turns`; NULL for claude |
| Budget gauge (session detail) | `dim_sessions.budget_utilization` | `turns_used / max_turns` (NULL when `max_turns` NULL/0) |
| Budget-killed KPI (dashboard) | `dim_sessions` | `COUNT(*) FILTER (WHERE session_status='budget_killed') WHERE start_ts >= since` |

The existing `status` column (`active`/`completed`, by `end_ts`) is unchanged and
separate — it answers "is the session still running", `session_status` answers
"how did it terminate".

### Filter semantics — known design tradeoff

| Usage | Filter applied | Consequence |
|-------|---------------|------------|
| Cost (dashboard hero, providers panel, models panel, daily chart) | `fact_daily_spend WHERE date >= since` — uses **event timestamp** | Accurate "spend incurred in period X" |
| Everything else (sessions, turns, tool calls, commits, people, apps) | `dim_sessions WHERE start_ts >= since` — uses **session start time** | Accurate "sessions started in period X" |

For short sessions these agree. For cross-midnight sessions a few dollars can land in a different bucket. This is intentional — cost attribution by event time is more accurate.

---

## Metric lineage

```
JSONL transcripts (Claude / Gemini)
  └─→ raw_events           (watcher → DuckDB)
        └─→ stg_events     (dbt staging)
              ├─→ stg_assistant_messages
              │     └─→ int_turns             (ASOF JOIN with user prompts)
              │           └─→ fact_turns      (+ calculated_cost from fact_model_calls join)
              │                 └─→ dim_sessions     (session-level roll-up of fact_turns)
              │                 └─→ fact_model_calls (event-level cost; date = CAST(ts AS DATE))
              │                       └─→ fact_daily_spend   (date × agent × model grain)
              │                       └─→ int_entity_spend   (date × entity_type × entity_id grain)
              │                             └─→ dim_apps / dim_agents / dim_people  (lifetime marts)
              ├─→ stg_tool_calls / stg_tool_results
              │     └─→ fact_tool_executions
              ├─→ stg_session_meta   (person_id, person_name, commits, session_title)
              └─→ stg_session_skills (skill_name)
```

---

## Dashboard (`/`) — `getDashboardKPIs`

All metrics in one `SELECT FROM dim_sessions WHERE start_ts >= since`, except cost which uses a `fact_daily_spend` subquery.

### Masthead strap

| Display | Table | Formula |
|---------|-------|---------|
| `X providers` | `fact_daily_spend` | `COUNT(DISTINCT provider)` from `getProviderSplit` result |
| `X people` | `dim_sessions` | `COUNT(DISTINCT person_id) WHERE start_ts >= since` |
| `X apps` | `dim_sessions` + `int_app_cwd_lookup` | scalar subquery: `COUNT(DISTINCT app_id) WHERE start_ts >= since` |
| `X sessions` | `dim_sessions` | `COUNT(DISTINCT session_id) WHERE start_ts >= since` |
| `X agents` | `dim_sessions` | `COUNT(DISTINCT agent) WHERE start_ts >= since` (was previously capped at top-20 list length) |

### Hero stat

| Display | Table | Formula |
|---------|-------|---------|
| SPEND `$X` | `fact_daily_spend` | `SUM(daily_cost) WHERE date >= since` |
| `X tokens` | `dim_sessions` | `SUM(total_input_tokens + total_output_tokens) WHERE start_ts >= since` |
| `X tool calls` | `dim_sessions` | `SUM(tools_used) WHERE start_ts >= since` |
| `X commits` | `dim_sessions` | `SUM(commits) WHERE start_ts >= since` |

> Note: SPEND uses event-timestamp filter; tokens/tool calls/commits use session-start filter. See design tradeoff above.

### KPI strip

| Display | Table | Formula |
|---------|-------|---------|
| Active now | `dim_sessions` | `COUNT(DISTINCT CASE WHEN status='active' THEN session_id END)` |
| Cache hit % | `dim_sessions` | `SUM(cache_read_total) / NULLIF(SUM(cache_read_total + ephemeral_5m_total + ephemeral_1h_total), 0)` |
| Tool calls | `dim_sessions` | `SUM(tools_used)` — identical to hero ✓ |
| Commits | `dim_sessions` | `SUM(commits)` — identical to hero ✓ |
| Errors | `fact_errors` | `COUNT(rows) WHERE ts >= since LIMIT 5` (only 5 fetched) |
| Projected 30d | client-side | `(total_cost / effectiveDays) × 30` |

### Daily chart

| Display | Table | Formula |
|---------|-------|---------|
| Cost bars | `fact_daily_spend` | `SUM(daily_cost) GROUP BY date WHERE date >= since` |
| Turns line | `fact_daily_spend` | `SUM(turn_count) GROUP BY date` |

### Apps table (main column)

| Column | Lifetime | Range |
|--------|---------|-------|
| Cost | `dim_apps.total_cost` | `SUM(int_entity_spend.total_cost) WHERE entity_type='app' AND date >= since` |
| Sessions | `dim_apps.session_count` | `SUM(int_entity_spend.session_count)` |
| Turns | `dim_apps.total_turns` | `SUM(int_entity_spend.total_turns)` |
| Agents | `NULL` | `NULL` — always `—` |

### Projects table (main column)

| Column | Table | Formula |
|--------|-------|---------|
| Cost | `dim_sessions` | `SUM(total_cost) GROUP BY project_id WHERE start_ts >= since` |
| Sessions | `dim_sessions` | `COUNT(DISTINCT session_id)` |
| Turns | `dim_sessions` | `SUM(turn_count)` |
| Apps | `dim_sessions` + `int_app_cwd_lookup` | `COUNT(DISTINCT app_id)` |

### Agents table (main column)

| Column | Lifetime | Range |
|--------|---------|-------|
| Cost | `dim_agents.total_cost` | `SUM(int_entity_spend.total_cost) WHERE entity_type='agent'` |
| Sessions | `dim_agents.session_count` | `SUM(int_entity_spend.session_count)` |
| Turns | `dim_agents.total_turns` | `SUM(int_entity_spend.total_turns)` |

### Sidebar panels

| Panel | Table | Formula |
|-------|-------|---------|
| People: cost | `dim_people` (lifetime) / `int_entity_spend` (range) | `total_cost` |
| Tool mix | `fact_tool_executions` | `COUNT(*) GROUP BY tool_name WHERE tool_call_ts >= since` |
| Providers: cost | `fact_daily_spend` | `SUM(daily_cost) GROUP BY provider WHERE date >= since` |
| Providers: % | client-side | `provider_cost / total_cost` |
| Models: cost | `fact_daily_spend` | `SUM(daily_cost) GROUP BY model WHERE date >= since` (no LIMIT in SQL; page displays top 8 with a "+ N more · $X of $Y" disclosure when truncated) |
| Cache 5m / 1h | `dim_sessions` | `SUM(ephemeral_5m_total)`, `SUM(ephemeral_1h_total) WHERE start_ts >= since` |
| Cache reads | `dim_sessions` | `SUM(cache_read_total) WHERE start_ts >= since` |

---

## Sessions page (`/sessions`) — `getSessionsStats` + `getSessions`

### Stats strip

All four stats come from `dim_sessions` with the same `WHERE {filters}` clause (provider, agent, status, search, date). Fully consistent.

| Display | Table | Formula |
|---------|-------|---------|
| Sessions | `dim_sessions` | `COUNT(*) WHERE {filters}` |
| Cost | `dim_sessions` | `COALESCE(SUM(total_cost), 0) WHERE {filters}` |
| Turns | `dim_sessions` | `SUM(turn_count) WHERE {filters}` |
| Commits | `dim_sessions` | `SUM(commits) WHERE {filters}` |

### Session table rows (`getSessions` — max 200 rows)

| Column | Table | Formula |
|--------|-------|---------|
| Started | `dim_sessions.start_ts` | |
| Person | `dim_sessions.person_name` | |
| App | `dim_apps.app_id` | via `LEFT JOIN dim_apps ON da.cwd = ds.cwd` |
| Agent | `dim_sessions.agent` | mode of `int_event_agent.agent_resolved` |
| Title | `dim_sessions.session_title` | first external user prompt (200 chars) or session UUID |
| Model | `dim_sessions.model` | dominant model by cost in session |
| Turns | `dim_sessions.turn_count` | `COUNT(*) FROM fact_turns` — LLM API calls, not human prompts |
| Commits | `dim_sessions.commits` | from `stg_session_meta` |
| Cost | `dim_sessions.total_cost` | `SUM(fact_model_calls.calculated_cost)` |

> The stats strip shows totals for **all** matching rows; the table shows **max 200** rows. The UI shows "showing X of Y" when truncated.

---

## Session detail (`/sessions/[id]`) — `getSession`

### Hero stat

| Display | Table | Formula |
|---------|-------|---------|
| SESSION COST | `dim_sessions.total_cost` | `SUM(fact_model_calls.calculated_cost)` |
| Prompts | `fact_prompts` | `prompts.length` (already fetched for Prompts tab) |
| Turns | `dim_sessions.turn_count` | `COUNT(*) FROM fact_turns` |
| Tokens | `dim_sessions` | `total_input_tokens + total_output_tokens` |
| Files | `dim_sessions.files_touched` | `COUNT(DISTINCT file_path) FROM fact_session_files` |

> Prompts count shown alongside turns so "0 prompts · 100 turns · $2.00" is self-explaining for subagent sessions.

### KPI strip

| Stat | Table | Formula |
|------|-------|---------|
| Turns | `dim_sessions.turn_count` | same as hero |
| Output tokens | `dim_sessions.total_output_tokens` | |
| Cache 1h | `dim_sessions.ephemeral_1h_total` | |
| Cache 5m | `dim_sessions.ephemeral_5m_total` | |
| Cache hit % | client-side | `cache_read / (cache_read + ephemeral_5m + ephemeral_1h)` |
| $ / turn | client-side | `total_cost / turn_count` |

### Turns tab (`fact_turns`)

| Column | Table | Formula |
|--------|-------|---------|
| Turn # | `fact_turns.turn_number` | row number within session |
| Tokens in / out | `fact_turns.input_tokens`, `output_tokens` | |
| Cost | `fact_turns.calculated_cost` | from `fact_model_calls` join |
| Cache columns | `fact_turns.cache_read_input_tokens`, etc. | |
| Context % | `fact_turns.context_pct` | |

### Prompts tab (`fact_prompts`)

| Display | Table | Formula |
|---------|-------|---------|
| Per-prompt cost | `fact_prompts.cost_total` | `SUM(fact_turns.calculated_cost)` in prompt's time span |
| Per-prompt turns | `fact_prompts.turn_count` | turns between this prompt and the next |
| Per-prompt tools | `fact_prompts.tool_call_count` | tool executions in span |

> `SUM(fact_prompts.cost_total)` across a session may be less than `dim_sessions.total_cost` when turns occur before the first external prompt (e.g. initial tool-result events in subagent sessions).

### Tool executions tab (`fact_tool_executions`)

| Column | Table | Formula |
|--------|-------|---------|
| Tool name | `fact_tool_executions.tool_name` | |
| Duration (s) | `fact_tool_executions.execution_duration_seconds` | |
| Is error | `fact_tool_executions.is_error` | |

---

## App profile (`/apps/[appId]`) — range-aware KPIs

When range filter is active: `getAppRangeAggregates` sources from `int_entity_spend` + direct `dim_sessions` for commits.
When no filter: falls back to `dim_apps` lifetime mart.

| KPI | Lifetime | Range |
|-----|---------|-------|
| SPEND | `dim_apps.total_cost` | `SUM(int_entity_spend.total_cost) WHERE entity_type='app' AND date >= since` |
| Sessions | `dim_apps.session_count` | `SUM(int_entity_spend.session_count)` |
| Turns | `dim_apps.total_turns` | `SUM(int_entity_spend.total_turns)` |
| Tokens | `dim_apps.total_output_tokens` | `SUM(int_entity_spend.total_output_tokens)` — now range-accurate |
| Commits | `dim_apps.commits` | `SUM(dim_sessions.commits) WHERE app_id=? AND CAST(start_ts AS DATE) >= since` |
| Agents count | `dim_apps.agent_count` | `NULL` → falls back to `dim_apps.agent_count` (lifetime) |
| Errors | `dim_apps.errors` | `NULL` → falls back to `dim_apps.errors` (lifetime) |

### Agents table within app

| Column | Lifetime | Range |
|--------|---------|-------|
| Cost | `dim_agents.total_cost WHERE app_id=?` | `SUM(fact_model_calls.calculated_cost)` via `dim_apps.cwd` join |
| Turns | `dim_agents.total_turns` | `SUM(dim_sessions.turn_count)` |
| Sessions | `dim_agents.session_count` | `COUNT(DISTINCT session_id)` |

### People table within app

| Column | Lifetime | Range |
|--------|---------|-------|
| Cost | `SUM(dim_sessions.total_cost) WHERE app_id=?` | `SUM(fact_model_calls.calculated_cost)` via `dim_apps.cwd` join |
| Turns | `SUM(dim_sessions.turn_count)` | `SUM(dim_sessions.turn_count)` |

### Sessions list within app (`LIMIT 12`)

All columns from `dim_sessions WHERE app_id=? AND start_ts >= since ORDER BY start_ts DESC LIMIT 12`.
Header KPI shows totals for **all** sessions; list shows **12**.

### Project siblings table

All columns from `dim_apps` (lifetime). Labeled **"lifetime figures"** in the UI.

---

## Agent profile (`/agents/[name]`) — range-aware KPIs

When range filter is active: `getAgentRangeAggregates` — two parallel queries.
When no filter: falls back to `dim_agents` lifetime mart.

| KPI | Lifetime | Range |
|-----|---------|-------|
| SPEND | `dim_agents.total_cost` (sum across app rows) | `SUM(int_entity_spend.total_cost) WHERE entity_type='agent'` |
| Sessions | `dim_agents.session_count` | `SUM(int_entity_spend.session_count)` |
| Turns | `dim_agents.total_turns` | `SUM(int_entity_spend.total_turns)` |
| Tool calls | `dim_agents.total_tool_calls` | `SUM(dim_sessions.tools_used) WHERE agent=? AND CAST(start_ts AS DATE) >= since` |
| Tokens | `dim_agents.total_output_tokens` | `SUM(int_entity_spend.total_output_tokens)` — range-accurate |
| Commits | `dim_sessions` | `dim_agents` has no `commits` column — summed via separate `SELECT COALESCE(SUM(commits), 0) FROM dim_sessions WHERE agent=?` in `getAgent()`. Labeled **(lifetime)** when range filter active. |
| Apps count | `dim_agents.app_count` | `NULL` → falls back to `dim_agents.app_count` (lifetime) |
| Errors | `dim_agents.errors` | always lifetime |

### Models table within agent

| Column | Table | Formula |
|--------|-------|---------|
| Cost | `fact_turns` | `SUM(calculated_cost) WHERE agent_resolved=?` via `int_event_agent` join |
| Sessions | `fact_turns` | `COUNT(DISTINCT session_id)` |

### Sessions list within agent (`LIMIT 12`)

From `dim_sessions WHERE agent=? AND start_ts >= since ORDER BY start_ts DESC LIMIT 12`.

---

## Person profile (`/people/[personId]`) — range-aware KPIs

When range filter is active: `getPersonRangeAggregates` — two parallel queries.
When no filter: falls back to `dim_people` lifetime mart.

| KPI | Lifetime | Range |
|-----|---------|-------|
| SPEND | `dim_people.total_cost` | `SUM(int_entity_spend.total_cost) WHERE entity_type='person'` |
| Sessions | `dim_people.session_count` | `SUM(int_entity_spend.session_count)` |
| Turns | `dim_people.total_turns` | `SUM(int_entity_spend.total_turns)` |
| Tokens | `dim_people.total_output_tokens` | `NULL` → falls back to `dim_people.total_output_tokens` (lifetime) |
| Commits | `dim_people.total_commits` | `SUM(dim_sessions.commits) WHERE person_id=? AND CAST(start_ts AS DATE) >= since` |
| Apps count | client-side | `appList.length` from `getPersonApps` result — respects range |
| Agents count | client-side | `agentList.length` from `getPersonAgents` result — respects range |
| Errors | hardcoded `—` | never populated |

### Sessions list within person (`LIMIT 20`)

From `dim_sessions WHERE person_id=? AND start_ts >= since ORDER BY start_ts DESC LIMIT 20`.

---

## Apps list (`/apps`)

| Column | Lifetime | Range |
|--------|---------|-------|
| Cost | `dim_apps.total_cost` | `SUM(int_entity_spend.total_cost) WHERE entity_type='app' AND date >= since` |
| Sessions | `dim_apps.session_count` | `SUM(int_entity_spend.session_count)` |
| Turns | `dim_apps.total_turns` | `SUM(int_entity_spend.total_turns)` |
| Errors | `dim_apps.errors` | `NULL` in range — not derivable without timestamp on `fact_errors` |

---

## Agents list (`/agents`)

| Column | Lifetime | Range |
|--------|---------|-------|
| Cost | `dim_agents.total_cost` | `SUM(int_entity_spend.total_cost) WHERE entity_type='agent'` |
| Sessions | `dim_agents.session_count` | `SUM(int_entity_spend.session_count)` |
| Turns | `dim_agents.total_turns` | `SUM(int_entity_spend.total_turns)` |

---

## People list (`/people`)

| Column | Lifetime | Range |
|--------|---------|-------|
| Cost | `dim_people.total_cost` | `SUM(int_entity_spend.total_cost) WHERE entity_type='person'` |
| Sessions | `dim_people.session_count` | `SUM(int_entity_spend.session_count)` |
| Turns | `dim_people.total_turns` | `SUM(int_entity_spend.total_turns)` |
| Commits | `dim_people.total_commits` | `SUM(int_entity_spend.commits)` — ⚠️ int_entity_spend.commits is `0::BIGINT` hardcoded in dbt; shows 0 on the list page in range view |

> Note: The people list page (`/people/page.tsx`) reads from `getPeople()` which does NOT call `getPersonRangeAggregates`. The commits=0 bug in `int_entity_spend` therefore still affects the **list page** in range view, even though the **detail page** now gets real commits via the separate `dim_sessions` query. Fix: call `getPersonRangeAggregates` from the list page, or fix `int_entity_spend.commits` in dbt.

---

## Errors page (`/errors`)

| Column | Table | Formula |
|--------|-------|---------|
| All rows | `fact_errors` | `SELECT * WHERE ts >= since ORDER BY ts DESC` |

---

## dbt mart changes (2026-05-28)

All previously-known gaps fixed in this round:

| Change | Where | What |
|--------|-------|------|
| `dim_apps.commits` | added | `SUM(stg_session_meta.commits)` per app. Lifetime view no longer shows `—`. |
| `dim_apps.agent_count` | added | `COUNT(DISTINCT agent_resolved)` per app via `int_event_agent` join. |
| `dim_apps.errors` | added | `COUNT(*)` from `fact_errors` joined on session. |
| `dim_people.total_input_tokens` | added | `SUM(total_input_tokens)` from `dim_sessions`. |
| `dim_people.total_output_tokens` | added | `SUM(total_output_tokens)` from `dim_sessions`. Lifetime view tokens no longer 0. |
| `int_entity_spend.commits` | fixed | Was `0::BIGINT` for all grains; now computed from `dim_sessions.commits` attributed to `CAST(start_ts AS DATE)`, aggregated to each entity × date. |
| `int_entity_spend.total_tool_calls` | fixed | Was `0::BIGINT`; now `COUNT(*)` from `fact_tool_executions` attributed to `CAST(tool_call_ts AS DATE)`, aggregated to each entity × date. |
| `int_entity_spend.total_turns` | fixed (latent bug) | Was `SUM(turns_by_date.turn_count)` after LEFT JOIN to per-event `fmc_base` — silently multiplied turn count by per-(session, date) turn count. Now `COUNT(*)` on `fmc_base` directly (which is already per-turn). |

**Important design pattern in `int_entity_spend`:** all per-entity-date metrics are computed in **separate aggregation CTEs per grain** (`{grain}_spend`, `{grain}_tools`, `{grain}_commits`) and then LEFT JOIN'd at the (entity, date) level. The previous structure (LEFT JOIN session-keyed helper into per-event base, then aggregate) silently multiplied joined values. The new structure guarantees each metric is summed exactly once per entity × date.

**Frontend redundancy:** The frontend's parallel commit queries in `getAppRangeAggregates`, `getPersonRangeAggregates`, and `getAgentRangeAggregates` are now redundant (the dbt mart provides correct values) but still correct. Left in place for safety; can be cleaned up in a future round.

---

## Latent risks (not bugs today, worth knowing)

- **`null ?? 0` masks empty data.** When a date range returns zero token rows but the rest of the dashboard has data, `SUM(total_input_tokens)` returns SQL `NULL` → JS `null`, and `null ?? 0` collapses to `0`. The UI shows "0 tokens" rather than "—". Unrealistic in practice (every assistant message has input tokens), but watch for it in the Cache panel for tenants who never use ephemeral caching.
- **SQL injection latent.** Range queries splice `${since}` directly into template literals. `since` is always derived from `rangeSince(parseRange(...))` which only ever returns an ISO string or `null` — safe today. If a new API route ever accepts a raw `since` from a client, it must be sanitized.

## The semantic-model argument

Every screen re-joins the same underlying tables with its own filter logic. Each new query path is another opportunity for drift — add a new filter, forget to apply it in one place, and a number silently disagrees.

The permanent fix is a **metrics semantic layer** (dbt Semantic Layer / MetricFlow, or a custom `metrics/` intermediate view) that defines `cost`, `turns`, `commits`, `tool_calls` once with a consistent date-spine. Every page then queries the metric, not the mart directly.

Until that exists, this document is the authoritative source for "which table does this number come from."
