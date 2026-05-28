# Apps — list view

**URL:** `/apps`  
**Primary range:** 7d  
**Variants:** 30d

## What this screen shows

A roster of all "apps" (distinct working directories, aka projects) ranked by cost and activity. Each card shows high-level project metadata, spending, session/turn counts, and the agents that worked in it.

## Layout & components

- **Masthead strap** — eyebrow label "Apps · {count} projects · {range}", range filter button, aggregate cost pill
- **Page hero** — large heading "{count} apps, _one ledger_", lede on project + agent + people tracking
- **Apps grid** — responsive card layout; each card shows:
  - Project ID + agent count (eyebrow)
  - App name (h3) + optional description (truncated to 200 chars)
  - {range} spend (right-aligned, bold)
  - **Stats row** — Sessions / Turns / Commits / Errors
  - **Agents row** — first 5 agents (chip style); overflow badge if > 5

## Data sources

| Component | Query | Mart |
|---|---|---|
| Apps ledger (lifetime) | `getApps()` (no range) | `dim_apps` |
| Apps ledger (range) | `getApps(since)` | `int_entity_spend` + `dim_apps` JOIN |
| Total aggregate cost | `getAppsTotalCost(since)` | `int_entity_spend` |

## How to read it

- **App identity:** distinct `cwd` (working directory). One `cwd` = one app.
- **Project rollup:** `project_id` groups apps; e.g., many apps may belong to the same monorepo project.
- **Cost driver:** sum of all `fact_model_calls.calculated_cost` in that app's cwd within the range.
- **Agent list:** agents that ran in the app (not exhaustive without a time-bound fact table; lifetime `dim_apps` has full agent list, range queries return NULL).
- **Commits:** git commits detected in turn artifacts; NULL on range queries (no timestamp on fact_errors).

## Edge cases / empty states

- **App with no cwd:** rare; UI shows `app_id` as fallback.
- **Range with no data:** empty grid; placeholder message "No apps found. Sessions will appear once dbt has run."
- **Agents > 5:** "Agents" row shows first 5 + "+N" overflow badge.
- **Range vs. lifetime:** range queries use pre-aggregated `int_entity_spend` (fast); lifetime queries use `dim_apps` (complete, includes agents list).

## Related screens

- [App detail](./app-detail.md) — per-app breakdown (agents, sessions, people, activity timeline)
- [Dashboard](./dashboard.md) — aggregate project rollup (no dedicated page; summary stats in main dashboard)

## Screenshots

- 7d: ![](./apps-list.png)
- 30d: ![](./apps-list-30d.png)
