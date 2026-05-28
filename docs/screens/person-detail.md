# Person detail — Aura

**URL:** `/people/<personId>`  
**Sample:** `unknown` (catches all backfilled sessions whose person wasn't resolved)  
**Primary range:** 7d  
**Variants:** all-time

## What this screen shows

Deep-dive profile for one operator (person) — their sessions, apps, agents, costs, and work patterns. Each person's identity comes from session metadata (`person_id` via OS username). The special ID `unknown` is the catch-all for sessions where the watcher couldn't determine person identity.

## Layout & components

- **Masthead** — person name/id, range selector, quick pill (session count + cost)
- **Profile head** — avatar, role, summary (sessions/apps/agents/commits), hero stat (spend for selected range)
- **KPI strip** — 6-stat layout (Sessions, Apps, Agents, Commits, Tokens, Errors)
- **Agents section** — who this person delegated to (cost split table with trend bar)
- **Apps section** — projects/apps this person worked in (cost by project)
- **Recent sessions** — last 20 sessions (date, agent, title, turns, cost)
- **Prompts sidebar** — up to 8 most recent prompts in their voice + mini stats

## Data sources

| Component | Query | Mart |
|---|---|---|
| Person profile | `getPerson(personId)` | `dim_people` |
| Range-aware KPIs | `getPersonRangeAggregates(personId, since)` | `int_entity_spend` (date-grain) |
| Sessions list | `getPersonSessions(personId, since)` | `dim_sessions` |
| Agents delegated to | `getPersonAgents(personId, since)` | `fact_model_calls` (range) / `dim_sessions` (lifetime) |
| Apps worked in | `getPersonApps(personId, since)` | `fact_model_calls` (range) / `dim_sessions` (lifetime) |
| Prompts sidebar | `getPersonPrompts(personId, limit, since)` | `fact_prompts` joined with `dim_sessions` |

**Range logic:**
- No filter → lifetime mart (fast path, from `dim_people`)
- With filter → pre-aggregated `int_entity_spend` for KPIs, date-filtered joins on `fact_model_calls` for agents/apps

## How to read it

1. **Person identity** — `person_id` is the OS username from session metadata. Matched to `person_name` via `dim_people` (resolve from `~/.aura/people.json` at ingest time).
2. **Unknown** — catch-all for sessions where the watcher couldn't write `session_meta.person_id`. Once the session_meta backfill is complete, this ID will shrink.
3. **Cost allocation** — KPI spend for the selected range comes from `int_entity_spend` (pre-aggregated daily). Individual agent/app costs are re-joined from `fact_model_calls` at the day grain for accuracy.
4. **Prompts** — sidebar shows recent actual user input (truncated to 200 chars) + counts of turns/tools/files touched during that prompt's span.

## Edge cases / empty states

- **No person_id match** → 404 via `notFound()`
- **No agents/apps data** → displays empty-block message
- **No sessions** → displays empty-block message
- **No prompts** → sidebar is hidden (graceful fallback if `fact_prompts` doesn't exist yet)
- **Unknown ID with 0 sessions** → person detail page still renders if `dim_people` has the row, else 404

## Related screens

- [People list](./people-list.md) — all operators, sorted by cost
- [Session detail](./session-detail.md) — deep dive into one session
- [Dashboard](./dashboard.md) — system-wide overview

## Screenshots

- 7d: ![](./person-detail.png)
- All: ![](./person-detail-all.png)
