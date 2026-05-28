# Dashboard (home)

**URL:** `/`  
**Primary range:** 7d  
**Variants captured:** today (hourly token chart), 30d, all-time

## What this screen shows

The dashboard is AURA's homepage — a single-page summary of agent activity, spending, and resource usage across all sessions in a selected time range. An operator lands here to see at a glance: total spend by provider, cache hit rates, token volume over time, top apps/projects/agents by cost, recent errors, and the most common skills and MCP servers loaded.

## Layout & components

- **Masthead strap** — range selector (7d/today/30d/all), provider count, total people, apps, sessions, agents, pipeline status indicator
- **Burn rate strip** — today's spend pace vs. 30-day average; projected 30-day run rate
- **Hero section** — headline ("Spend, with receipts"), multi-line lede (provider summary + total cost over range), action buttons to Sessions/Apps/People
- **Hero stat** — right side display of total cost + mini sparkline (daily spend over last 14 days) + token/tool/commit footers
- **KPI strip (6 tiles)** — active sessions, cache hit rate, total tool calls, commits, error count, projected 30-day spend
- **Token volume chart** — stacked bar chart, bucketed hourly for `range=today` or daily otherwise; token types: input, output, cache 5-min, cache 1-hour, cache read
- **Apps ledger** — top 10 apps by cost; columns: rank, app name/id, agent count, session count, cost, relative share bar
- **Projects ledger** — nested rollup; shows top projects with child apps indented beneath; columns: rank, project name, app count, session count, turns, cost, share
- **Agents ledger** — top 20 agents by cost; columns: rank, agent name, app, project, session count, turns, cost, share
- **Files section** — top 8 most-edited files; showing file extension badge, path (last 3 components), edit count bar
- **Errors section** — recent errors (last 5); timestamp, severity badge, error kind, tool, message, session link
- **Activity heatmap** — 7-day × 24-hour grid showing turn count and cost by day-of-week and hour; hover for details
- **Side panel (right)** — Top people (6), Tool mix (bar chart), Providers (stacked bar + table), Models (stacked bar + top 8 table), Cache (5m vs 1h split), Editor's Note quote
- **Skills & MCPs** — bottom section, two-column grid showing top 10 skills and top 10 MCP servers; columns: name, session count, last used date

## Data sources

| Component | Query function | Source table(s) |
|---|---|---|
| KPI strip (spend, sessions, cache, etc.) | `getDashboardKPIs` | `dim_sessions`, `fact_daily_spend`, `int_app_cwd_lookup` |
| Daily spend sparkline | `getDailySpend` | `fact_daily_spend` |
| Token series (hourly/daily) | `getTokenSeries` | `fact_model_calls` |
| Apps ledger | `getTopApps` | `dim_apps` (lifetime) or `int_entity_spend` (range) |
| Projects ledger | `getTopProjects` | `dim_sessions`, `int_app_cwd_lookup`, `dim_projects` |
| Agents ledger | `getTopAgents` | `dim_agents` (lifetime) or `int_entity_spend` (range) |
| Tool mix | `getToolMix` | `fact_tool_executions` |
| Providers split | `getProviderSplit` | `fact_daily_spend` |
| Models breakdown | `getModelBreakdown` | `fact_daily_spend` |
| Recent errors | `getRecentErrors` | `fact_errors` |
| Top files | `getTopFiles` | `fact_session_files` ⋈ `dim_sessions` |
| Top people | `getTopPeople` | `dim_people` (lifetime) or `int_entity_spend` (range) |
| Hourly activity heatmap | `getHourlyActivity` | `fact_hourly_activity` |
| Spend pace (burn rate) | `getSpendPace` | `fact_spend_pace` |
| Editor's note (loudest prompt) | `getLoudestPromptOfDay` | (from prompts module) |
| Top skills | `getTopSkills` | `raw_session_skills` ⋈ `dim_sessions` |
| Top MCPs | `getTopMcps` | `raw_session_mcps` ⋈ `dim_sessions` |

## How to read it

**Spend:** Start at the hero stat (top right) — that's the dollar total. Look at the daily sparkline to spot trends (flat = consistent, spike = one expensive day). The KPI "Projected 30d" extrapolates the daily average across the range to a 30-day forecast.

**Activity:** The KPI strip shows sessions, tool calls, and commits. High active-sessions count = concurrent work; low error count = a quiet period. The heatmap reveals when work happens (e.g., if 9–10am is empty, batch jobs may be scheduled midnight).

**Tokens:** The token chart's bucket changes with range: hourly for today (24 bars, useful for spotting peak hours), daily for 7d/30d/all (one bar per day, trend view). Stacked colors show token mix: real input/output (bottom) vs. cache-weighted tokens (5m/1h/read); high cache-read portions = good reuse.

**Cache:** In the side panel, "Cache · ephemeral" shows 5-minute vs. 1-hour write volumes. A sudden 1-hour spike indicates expensive write operations that will save future reads; keep the cache hit rate in the KPI strip high (60%+ is good, >80% is excellent).

**Errors:** If error count is non-zero, click "see all" to drill into `/errors`. A sudden spike may indicate a broken tool, model, or parsing issue.

**Skills & MCPs:** These tables are populated after the first dbt cycle following a new skill/MCP deployment. Session count is the denominator for adoption; last-used date shows recency.

## Edge cases / empty states

- **No data in range:** Apps, Projects, Agents, Files, and Skills sections show empty-block placeholders (gray background, "No X data — dbt mart will populate after next run.").
- **Range=today before first session:** Token chart returns empty array; displays "No token data in this range."
- **Skills or MCPs not yet indexed:** Tables show "No skills/MCPs loaded in this range." until `raw_session_skills`/`raw_session_mcps` rows are populated.
- **No errors:** Errors section shows "No errors recorded — a quiet [range]."
- **Zero cost:** All darts/legends gracefully handle division by max(cost, 0.001) to avoid division-by-zero errors.

## Related screens

- [Sessions list](./sessions-list.md) — detailed transcript explorer
- [Tokens drill-down](./tokens-page.md) — per-model token breakdown
- [Apps list](./apps-list.md) — app profile, sessions within each app
- [Observability](./observability.md) — medallion health, dbt runtime, watcher lag
- [People](./people.md) — person-specific spend and activity
- [Errors detail](./errors.md) — full error log with filtering

## Screenshots

**7d (primary):**
![](./dashboard.png)

**Today (hourly token buckets):**
![](./dashboard-today.png)

**30d:**
![](./dashboard-30d.png)

**All-time:**
![](./dashboard-all.png)
