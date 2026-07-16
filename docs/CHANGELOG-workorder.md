# Work Order Changelog

Per-task summary of the AURA Improvement Work Order. Newest task last.

## Task 1 — Ingest SDK agent traces

**Watcher**
- New `adapters/sdk_trace.py` (`SdkTraceAdapter`): maps Agent SDK trace JSONL onto
  the Claude `raw_events` shape. `message`/`result` → `event_type='assistant'` with
  a synthesised `message_id` (the `result` event merges onto the last `message`
  turn so `turn_count` stays accurate and the verbatim cost lands on one turn);
  other kinds are faithful markers. Synthesised `session_id` (filename stem),
  `uuid` (`session_id:byte_offset`), `ts` (`file_mtime + t`), `source='sdk_trace'`,
  `reported_cost_usd` (= `result.total_cost_usd`).
- `duckdb_writer.py`: `raw_events` gains `source TEXT DEFAULT 'claude'` and
  `reported_cost_usd DOUBLE`, with idempotent `ADD COLUMN IF NOT EXISTS` migrations.
- `main.py`: `AURA_EXTRA_TRACE_DIRS` (extra watched/backfilled dirs) + per-file
  adapter sniffing (`adapter_for_file`: first-line `"kind"` → SDK, else Claude).
- `session_meta.py`: SDK title extraction from `run_start.prompt`.
- Tests: `test_sdk_trace_adapter.py`, `test_session_meta_sdk.py`, + sniffing/e2e
  cases in `test_main.py`. Full watcher suite: **58 passed**.

**dbt**
- `source` + `reported_cost_usd` threaded `stg_events` → `stg_assistant_messages`
  → `fact_model_calls`; `dim_sessions` gains `source` via a `source_per_session` CTE.
- `fact_model_calls.calculated_cost` short-circuits `source='sdk_trace'` to verbatim
  `COALESCE(reported_cost_usd, 0)` — cost is NOT recomputed from token pricing.
- `schema.yml`: `not_null` + `accepted_values(['claude','sdk_trace'])` on
  `dim_sessions.source`. Full `dbt build` **PASS=89**; verified an sdk_trace session
  reconciles `total_cost == total_cost_usd` for single- and multi-turn runs.

**Frontend**
- `SdkBadge` atom; rendered on `/sessions` rows (Model cell) and the
  `/sessions/[id]` detail header when `source === 'sdk_trace'`. `ds.source` added to
  `getSessions`; `Session` type extended. `next build` green.

**Docs**
- number-map: "Source-specific cost: `sdk_trace` (verbatim)" + timestamp-anchoring
  note. HOW-IT-WORKS: "SDK agent traces (second adapter)" section.

## Task 2 — Run-outcome semantics (completed / budget_killed / interrupted / error / unknown)

**Design note:** `session_status` and the budget fields are **derived in dbt** from
`raw_events` events, not persisted via `session_meta` as the work order's wording
suggested — the SDK adapter already stores `run_start`/`result`/`run_end`/
`interrupted` events with the needed fields, and `dim_sessions` already derives its
existing `status` column in dbt, so this is the smaller, more consistent change and
refreshes every dbt cycle. No watcher change.

**dbt**
- `dim_sessions`: new `sdk_run_meta` CTE (reads sdk_trace events only); 4 new
  columns — `session_status` ∈ {completed, budget_killed, interrupted, error,
  unknown}, `turns_used`, `max_turns`, `budget_utilization` (last three
  sdk_trace-only; claude best-effort `turn_count>0 → completed`, else `unknown`).
- `schema.yml`: `not_null` + `accepted_values` on `session_status`. Verified all
  four sdk outcomes (budget_killed/error/interrupted/completed) + the claude branch
  on real data; build green.

**Frontend**
- `StatusPill` atom (severity-toned, `completed` quiet); new **Status** column on
  `/sessions` + pill in the session-detail header. Budget gauge (`TBar`) on detail
  when `max_turns` known. Dashboard **Budget-killed** KPI
  (`COUNT(*) FILTER (session_status='budget_killed')`). `next build` green.

**Docs**: number-map "Run-outcome status" section; sessions-list / session-detail /
dashboard screen notes.
