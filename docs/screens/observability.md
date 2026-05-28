# Observability

**URL:** `/observability`  
**Range:** N/A (always live, 10s polling)

## What this screen shows

Operator's dashboard for real-time pipeline health and diagnostics. Synthesizes signals from watcher heartbeat, bronze freshness, dbt test results, and source freshness to present a unified verdict. Continuously polls every 10 seconds for live updates.

## Layout & components

- **Pipeline verdict** — synthesised health status (bronze freshness, dbt tests, watcher errors, source freshness) with actionable issues and links
- **Flow strip (I)** — Watcher → Bronze → Silver → Gold → Consumers with per-stage tone and KPIs
- **Medallion layers (II)** — bronze/silver/gold row counts, age, bytes, and test pass rate (batched UNION query)
- **KPI grid (III)** — watcher, bronze, dbt, and error counts across 4 columns
- **Ingestion volume (IV)** — sparklines for 1h/1d/7d row ingestion trends
- **Source freshness (V)** — dbt source freshness table (status, age, max_loaded_at)
- **dbt tests (VI)** — test result grid, pass/fail counts, breakdown by relation
- **Recent invocations (VII)** — last N dbt run artifacts with command, duration, outcome
- **Watcher errors feed (VIII)** — timestamps show date + time to disambiguate cross-day errors
- **Artifacts footer** — expandable run_results.json and sources.json for debugging

## Data sources

| Component | Source |
|---|---|
| Pipeline live | watcher heartbeat, ingest_checkpoints, snapshot mtime |
| Medallion | UNION over raw_events, stg_*, marts |
| Watcher errors | `watcher_errors` source |
| Run history | /data/artifacts/history JSON files |

## How to read it

- Pipeline 'green' = recent heartbeat + recent snapshot + dbt tests passing
- Bronze freshness gap > minutes = stuck stage
- Watcher error rate = parser fragility / lock contention

## Edge cases / empty states

- First run: history empty
- Watcher down: heartbeat stale, verdict red

## Related screens

- [Dashboard](./dashboard.md)
- [Errors](./errors-list.md)

## Screenshots

![](./observability.png)
