# Observability — Aura

**URL:** `/observability`  
**Range:** N/A (always live / cumulative)

## What this screen shows

Live operator's view of the data pipeline — watcher health, dbt cycle, medallion freshness, recent errors. Single consolidated page rebuilt in commit 0903436 to replace separate observability surfaces with one unified dashboard.

## Layout & components

### Pipeline Status (verdict)
- Overall pipeline state (green/yellow/red): synthesized from bronze freshness, dbt test passes, watcher errors, source freshness
- Headline + summary dynamically derived based on failure signatures
- Issues list with jump links to relevant sections

### Flow (I)
- 5-stage pipeline visualization: Watcher → Bronze → Silver → Gold → Consumers
- Each stage shows health tone, key metric (rows/1h, age, test passes, tables), and supporting note
- Connections indicate data flow; dashed red arrows indicate faults

### Medallion layers (II)
- Bronze, silver, gold organized by layer
- Per-layer role, materialization, stats (tables, rows, size, age of newest row)
- Per-table listing (first 10 tables shown)
- Test pass rate bar for gold layer (if tests exist)

### At a glance (III)
- 4-column KPI grid: Watcher, Bronze, dbt, Errors
- Watcher: files watched, bytes ingested, errors/1h
- Bronze: raw_events age, rows/1h, rows/7d
- dbt: test pass/fail counts, last run duration + time, artifacts timestamp
- Errors: counts for 1h and today, stream size

### Ingestion volume (IV)
- Sparklines for last 1h, 1d, 7d ingestion
- Each cell shows row count + visual trend
- Empty state if no events ingested

### Source freshness (V)
- Table of dbt source freshness checks
- Columns: source, table, status (pass/warn/error), max loaded at, age, snapshotted at
- Error/warn rows highlighted

### dbt tests (VI)
- Test grid: each cell is one test (pass = green, fail = red)
- Per-relation (table) summary: pass/fail counts and test kinds (unique, not_null, etc.)
- Legend showing pass/fail totals and cumulative execution time

### Recent invocations (VII)
- Chronological list of dbt runs from artifact history
- Time, command, outcome, duration, model+test counts
- Latest run marked

### Watcher errors (VIII)
- Live error feed: timestamp (date · HH:MM:SS), level, source, message
- Newest first (up to 20 shown)
- Empty state if clean

### Raw artifacts (footer)
- Expandable toggles for run_results.json and sources.json from last dbt invocation
- Metadata: sampling interval (10s), snapshot authority time

## Data sources

| Component | Query / API | Source |
|---|---|---|
| Pipeline verdict | Synthesized from below | derived logic in PipelineLive.tsx |
| Flow + KPI | Direct DB queries | watcher health, bronze age, ingestion stats, dbt tests |
| Medallion | Batched UNION per layer | `raw_events`, `stg_*`, marts tables (see commit e7d3471) |
| Watcher errors | Table scan | `watcher_errors` table |
| dbt history | File scan | `/data/artifacts/history/*.json` |
| Artifacts | File metadata | `run_results.json`, `sources.json` mtime |

## How to read it

- **Green flow**: pipeline keeping pace, tests passing, no errors
- **Yellow stage**: degraded (stale bronze, test warnings, source drift)
- **Red stage**: critical (no ingestion, test failures, source error)
- **Bronze age**: freshness metric for raw_events; < 1 min ideal, > 30 min is error threshold
- **dbt tests**: should be > 0 and all pass; failing tests indicate transform bugs
- **Errors stream**: most recent watcher errors (e.g., malformed JSONL, checkpoint write failures)
- **Artifacts timestamp**: when dbt last ran successfully; stale (> 1h) suggests dbt stuck or not triggered

## Edge cases / empty states

- First run after deploy: history empty, artifacts not yet written, verdict "unknown"
- Watcher down: bronze age increases, ingestion_1h = 0, verdict becomes "action required"
- dbt never run: tests show 0/0, artifacts timestamp "—", no history rows
- No errors: errors stream shows clean checkmark + "running clean"

## Related screens

- [Dashboard](./dashboard.md)
- [Errors](./errors-list.md)

## Screenshots

![Observability page screenshot](./observability.png)
