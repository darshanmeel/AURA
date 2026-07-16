# People — list view

**URL:** `/people`  
**Primary range:** 7d  
**Variants:** all-time

## What this screen shows

The operator roster: a summary of every person who has used Claude Code in your Aura instance. Each person card shows their spend, session count, turns executed, commits made, and the applications and agents they've used. A cost bar compares each operator's spend against the top spender. This view is the entry point for deep-diving into what individual operators are delegating to agents and how much they cost.

## Layout & components

- **Masthead strap** — count of operators, selected time range (7d/all), total sessions & aggregate cost
- **Hero section** — page title and lede describing the count of unique apps and agents across all people
- **People grid** — card layout, one per operator
  - **Card head** — avatar + name (person_id fallback), optional role
  - **Card stats** — Cost, Sessions, Turns, Commits (key KPIs)
  - **Card meta** — Apps touched (list of cwd-inferred app names) and Agents used (up to 4, +N overflow)
  - **Cost bar** — horizontal bar showing this operator's spend as % of the top spender; label shows % of org spend

## Data sources

| Component | Query | Mart |
|---|---|---|
| Roster list (with KPIs) | `getPeople(since)` | `dim_people` (lifetime) or `int_entity_spend` (range-filtered, 7d/30d/all) |
| Person name | `dim_people` join (person_id → person_name) | `dim_people` (from `session_meta`) |
| Apps, Agents arrays | `dim_people` | Lifetime data; range filter affects KPI numbers only |

## How to read it

- **person_id** — typically matches `AURA_DEFAULT_PERSON_ID` environment variable (falls back to OS user, e.g. `root`)
- **person_name** — comes from `AURA_DEFAULT_PERSON_NAME` env var or `~/.aura/people.json` lookup; maps session_id to a human name
- **'Unknown' rows** — sessions whose original JSONL file is no longer on disk (deleted or moved from `~/.claude/projects/`)
- **Range filter (7d/30d/all)** — applies to KPI numbers (cost, sessions, turns, commits) only; apps and agents arrays remain lifetime data (see note in `getPeople()`)

## Edge cases / empty states

- After the session_meta backfill fix: **311/349** sessions now resolve to 'darshan' (Darshan Singh)
- **38 legacy sessions** remain 'Unknown' — they exist in `raw_events` but their JSONL files were not found during backfill (orphaned logs)
- Empty roster — if no sessions match the selected range, the grid is empty and stats show 0
- Single operator — masthead shows "1 operator" (singular)

## Related screens

- [Person detail](./person-detail.md) — linked via person-card click; shows deep dive into one operator's session history, agent spend, app usage, and actual prompts typed

## Screenshots

- **7d range:** ![](./people-list.png)
- **All-time:** ![](./people-list-all.png)
