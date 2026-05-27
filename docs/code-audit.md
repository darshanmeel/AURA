# Aura — Code Audit

**Date:** 2026-05-27
**Scope:** Full codebase compared against `README.md` as the source of truth for current intended state.
**Method:** Read-only review. No code changed.

---

## 1. Executive Summary

- **Biggest single win: delete ~60 debug artifacts from the repo root.** `*.mjs`, `*.png`, `*.sql`, `FRONTEND_DIAGNOSIS.md` are all untracked test/diagnostic files that make `git status` noisy and confuse newcomers. They can be deleted without touching any running code.
- **Agent definition files are entirely wrong.** `frontend-engineer.md`, `data-engineer.md`, `dbt-expert.md`, `runner.md`, and `code-reviewer.md` all describe a Streamlit surface that was replaced by Next.js. Every new agent dispatch operates under the wrong mental model.
- **`aura.toml` (repo root) and `examples/aura.toml` are both permanently inconsistent with the running system.** They reference `aura_read.duckdb` with the old flat path, while the actual system uses `/data/read/aura.duckdb`. The README calls the file "defined but currently ignored" — it is, but the stale content actively misleads.
- **Three `safe()` / `tsFilter` / `andTsFilter` copies exist with no shared home.** `dashboard.ts`, `apps.ts`, `agents.ts`, `errors.ts`, `people.ts` all re-declare `tsFilter`; `safe()` appears in `route.ts`, `api/observability/route.ts`, and `app/page.tsx` (as an inline arrow). `formatAge`, `formatTimestamp`, and `statusColor` appear independently in `LiveOverview.tsx` and `DbtPageClient.tsx`.
- **`aura_semantic.yml` documents `int_entity_spend` with incorrect column descriptions** (`date` described as `CAST(dim_sessions.start_ts AS DATE)`, `agent` described as `dim_sessions.agent`) that contradict the actual SQL, which uses `fact_model_calls.ts` and `fact_model_calls.agent`. This misleads anyone reading the docs.

---

## 2. Stale References to Old Surfaces

### 2.1 Streamlit references in agent definition files

The entire `frontend-engineer.md` agent definition is written for the Streamlit surface that no longer exists:

- `D:\darshanmeel\AURA\.claude\agents\frontend-engineer.md:3` — description says "Streamlit surface specialist for Aura. Owns streamlit/ — app.py, pages/1_Sessions.py, pages/2_Trends.py"
- `D:\darshanmeel\AURA\.claude\agents\frontend-engineer.md:12` — "You own the `streamlit/` surface"
- `D:\darshanmeel\AURA\.claude\agents\frontend-engineer.md:16–18` — describes three Streamlit files (`app.py`, `1_Sessions.py`, `2_Trends.py`) that do not exist
- `D:\darshanmeel\AURA\.claude\agents\frontend-engineer.md:20` — "Own the `streamlit/Dockerfile`"

Cross-references from other agents pointing at the wrong surface:

- `D:\darshanmeel\AURA\.claude\agents\data-engineer.md:27` — "No Streamlit. You do not touch `streamlit/`."
- `D:\darshanmeel\AURA\.claude\agents\data-engineer.md:74` — "Streamlit opens per-query, not persistent"
- `D:\darshanmeel\AURA\.claude\agents\dbt-expert.md:26` — "No Streamlit code. You do not touch `streamlit/`."
- `D:\darshanmeel\AURA\.claude\agents\runner.md:17` — lists `frontend-engineer` as "for `streamlit/` (pages, fragments, charts)"
- `D:\darshanmeel\AURA\.claude\agents\runner.md:21` — "`frontend-engineer` for `streamlit/`"
- `D:\darshanmeel\AURA\.claude\agents\runner.md:36` — "Streamlit copy fix"
- `D:\darshanmeel\AURA\.claude\agents\code-reviewer.md:3` — description includes "streamlit/"
- `D:\darshanmeel\AURA\.claude\agents\code-reviewer.md:16` — "Review any diff (watcher, dbt, streamlit, config)"
- `D:\darshanmeel\AURA\.claude\agents\code-reviewer.md:20,38,72,73` — multiple Streamlit checklist items

`CLAUDE.md` also carries one vestigial Streamlit reference:

- `D:\darshanmeel\AURA\CLAUDE.md:68` — "A Streamlit page change does not touch dbt." This is in the Karpathy "Surgical Changes" example and is now wrong.

### 2.2 Old read-DB filename (`aura_read.duckdb` vs `/data/read/aura.duckdb`)

The actual running system uses `/data/read/aura.duckdb` (a file named `aura.duckdb` inside a `read/` subdirectory). Several places still use the old flat-sibling name:

- `D:\darshanmeel\AURA\aura.toml:8` — `read_path = "/data/aura_read.duckdb"`
- `D:\darshanmeel\AURA\examples\aura.toml:15` — `read_path  = "/data/aura_read.duckdb"`
- `D:\darshanmeel\AURA\.claude\agents\data-engineer.md:19` — "snapshot.py — copy to `aura_read.duckdb.tmp`"
- `D:\darshanmeel\AURA\.claude\agents\data-engineer.md:27` — "your contract ends at `aura_read.duckdb`"
- `D:\darshanmeel\AURA\.claude\agents\data-engineer.md:74` — "copy to `aura_read.duckdb.tmp`"
- `D:\darshanmeel\AURA\.claude\agents\code-reviewer.md:68` — "snapshot worker copies to `aura_read.duckdb`; Streamlit reads `aura_read.duckdb` only"
- `D:\darshanmeel\AURA\.claude\agents\frontend-engineer.md:12,24,41,43,57` — multiple references to `aura_read.duckdb`
- `D:\darshanmeel\AURA\watcher\src\aura_watcher\snapshot.py:13` — comment explains the catalog-name constraint and mentions `aura_read.duckdb` as an example of the wrong pattern
- `D:\darshanmeel\AURA\watcher\src\aura_watcher\main.py:207` — default `read_db_path = "/data/aura_read.duckdb"` — this is the **actual running default**; it disagrees with `docker-compose.yml` which passes `AURA_READ_DB_PATH=/data/read/aura.duckdb`. Docker always wins since the env var is set, but a bare `python -m aura_watcher` without the env var will use the wrong path.
- `D:\darshanmeel\AURA\frontend\lib\db.ts:4` — `const DB_PATH = process.env.AURA_READ_DB_PATH ?? '/data/aura_read.duckdb'` — same issue: the env var is set in Docker but the hardcoded fallback is wrong for local dev without Docker.

### 2.3 `dbt_running.is_set()` short-circuit reference (partially fixed)

The process_file function has an explanatory comment at line 17 noting the old bug is gone. However, the `on_created` handler at `D:\darshanmeel\AURA\watcher\src\aura_watcher\main.py:95` still checks `if not dbt_running.is_set()` before calling `write_session_meta`:

```python
with _snapshot_lock:
    if not dbt_running.is_set():
        write_session_meta(self.writer, session_id, event.src_path)
```

This means a newly-created JSONL file that appears during a dbt cycle will have its session_meta silently skipped. The comment in `process_file` says the short-circuit was removed, but it still exists in `on_created`. This is an inconsistency: the intent was to remove it, and the backfill path in `main()` (lines 245–259) handles the fallback correctly, but the live-watcher `on_created` path does not.

### 2.4 Outdated `dbt_run_interval_minutes` default in `aura.toml`

`D:\darshanmeel\AURA\aura.toml:14` — `dbt_run_interval_minutes = 60`, while `docker-compose.yml:20` and `main.py:208` both default to `5`. The README table (line 137) also says the default is `5`. The toml says `60`.

### 2.5 Stale `dim_sessions.total_cost` as cost source

No direct references to `dim_sessions.total_cost` as the authoritative cost source appear in the running code — this migration is complete. The old cost path is gone. (Verified: all range-filtered cost reads go through `fact_model_calls` or `int_entity_spend`.)

---

## 3. Files / Directories Safe to Delete If Starting Fresh

### 3.1 Debug scripts in repo root (all untracked per `git status`)

These are Playwright/DuckDB diagnostic scripts written during development and never cleaned up. They have no references from any running code and can be deleted without impact.

**`.mjs` debug scripts (15 files):**
- `D:\darshanmeel\AURA\check_db.mjs`
- `D:\darshanmeel\AURA\check_db2.mjs`
- `D:\darshanmeel\AURA\check_db_data.mjs`
- `D:\darshanmeel\AURA\check_errors.mjs`
- `D:\darshanmeel\AURA\decode_flight.mjs`
- `D:\darshanmeel\AURA\decode_flight2.mjs`
- `D:\darshanmeel\AURA\decode_flight3.mjs`
- `D:\darshanmeel\AURA\decode_flight4.mjs`
- `D:\darshanmeel\AURA\diagnose.mjs`
- `D:\darshanmeel\AURA\diagnose2.mjs`
- `D:\darshanmeel\AURA\diagnose_dev.mjs`
- `D:\darshanmeel\AURA\diagnose_dev2.mjs`
- `D:\darshanmeel\AURA\diagnose_hydration.mjs`
- `D:\darshanmeel\AURA\diagnose_precise.mjs`
- `D:\darshanmeel\AURA\inspect_db.mjs`
- `D:\darshanmeel\AURA\inspect_db2.mjs`
- `D:\darshanmeel\AURA\list_tables.mjs`
- `D:\darshanmeel\AURA\test_dashboard.mjs`
- `D:\darshanmeel\AURA\test_dashboard_final.mjs`
- `D:\darshanmeel\AURA\test_frontend.mjs`
- `D:\darshanmeel\AURA\test_home.mjs`
- `D:\darshanmeel\AURA\test_sections.mjs`
- `D:\darshanmeel\AURA\verify_dashboard.mjs`
- `D:\darshanmeel\AURA\verify_final.mjs`
- `D:\darshanmeel\AURA\verify_full.mjs`
- `D:\darshanmeel\AURA\verify_numbers.mjs`
- `D:\darshanmeel\AURA\verify_numbers.py`
- `D:\darshanmeel\AURA\verify_page_agents.mjs`
- `D:\darshanmeel\AURA\verify_page_apps.mjs`
- `D:\darshanmeel\AURA\verify_page_dashboard.mjs`
- `D:\darshanmeel\AURA\verify_page_errors.mjs`
- `D:\darshanmeel\AURA\verify_page_people.mjs`
- `D:\darshanmeel\AURA\verify_page_people_detailed.mjs`
- `D:\darshanmeel\AURA\verify_page_sessions.mjs`
- `D:\darshanmeel\AURA\verify_widgets.mjs`

**SQL file:**
- `D:\darshanmeel\AURA\today_usage.sql`

**Diagnostic markdown:**
- `D:\darshanmeel\AURA\FRONTEND_DIAGNOSIS.md` — describes an early state where the frontend was empty. Superseded by `docs/code-review.md`.

**Screenshot PNGs (all untracked, ~45 files):**
All `verify_*.png`, `dashboard_*.png`, `home_screenshot.png` in the repo root. Representative sample: `verify_01_dashboard.png`, `verify_full_dashboard.png`, `verify_widgets.png`, `dashboard_screenshot.png`, `dashboard_bottom.png`, `dashboard_top.png`, `dashboard_middle.png`, `dashboard_with_data.png`, `home_screenshot.png`.

### 3.2 Root-level `package.json` / `package-lock.json` / `node_modules/`

`D:\darshanmeel\AURA\package.json` declares `playwright` and two DuckDB packages. It is at the repo root, not inside `frontend/`. The `node_modules/` tree in the repo root is untracked and contains `playwright-core` and `duckdb` (these were used by the root-level `.mjs` diagnostic scripts). They are safe to delete; the frontend has its own `frontend/package.json` and `frontend/node_modules/`.

`D:\darshanmeel\AURA\package.json` should be deleted together with `D:\darshanmeel\AURA\package-lock.json` and `D:\darshanmeel\AURA\node_modules/` once the diagnostic `.mjs` files are removed.

### 3.3 `aura.toml` at repo root vs `examples/aura.toml`

Both files are stale (wrong read DB path, wrong dbt interval). The README roadmap item says `aura.toml` is "defined but currently ignored". Decision required: either wire it up or delete it. Both files contain `aura_read.duckdb` for the read path — which `snapshot.py:13` explicitly documents as the wrong thing to use.

- `D:\darshanmeel\AURA\aura.toml` — stale, unused
- `D:\darshanmeel\AURA\examples\aura.toml` — stale, unused

### 3.4 `dbt/models/staging/.gitkeep`, `dbt/models/intermediate/.gitkeep`, `dbt/models/marts/.gitkeep`

These placeholder files exist alongside real SQL models. They are harmless but noise. Once at least one file exists in each directory, `.gitkeep` serves no purpose.

### 3.5 `aura_semantic.yml` — partially dead

`D:\darshanmeel\AURA\dbt\models\marts\aura_semantic.yml` documents `int_entity_spend` as a semantic model ("for range-filtered API queries"). The file's own header says it is for "MetricFlow / dbt Semantic Layer adoption" — a roadmap item explicitly listed as not yet done in `README.md:271`. dbt will parse this YAML as supplemental documentation but no MetricFlow queries are wired. It is not dead (dbt merges it with `schema.yml` for descriptions), but the `int_entity_spend` descriptions inside it contain factual errors (see Section 5).

---

## 4. DRY Violations

### 4.1 `tsFilter` / `andTsFilter` duplicated across five query files

The following files each define their own copy of `tsFilter(col, since)` (and some also `andTsFilter`):

- `D:\darshanmeel\AURA\frontend\lib\queries\dashboard.ts:6–14`
- `D:\darshanmeel\AURA\frontend\lib\queries\apps.ts:5–9`
- `D:\darshanmeel\AURA\frontend\lib\queries\agents.ts:3–7`
- `D:\darshanmeel\AURA\frontend\lib\queries\errors.ts:3–13`
- `D:\darshanmeel\AURA\frontend\lib\queries\people.ts:3–7`

All five implementations are identical. `sessions.ts` does not define its own but instead builds the WHERE clause inline using array-of-conditions. These helpers belong in a shared `frontend/lib/queries/_helpers.ts` (or exported from `frontend/lib/range.ts` which already exports `tsFilter`-like logic via `rangeSince`).

### 4.2 `safe()` defined in three places

A `safe<T>(label, fn, fallback)` helper exists in:

- `D:\darshanmeel\AURA\frontend\app\api\dashboard\route.ts:16–20` — as a module-level `async function`
- `D:\darshanmeel\AURA\frontend\app\api\observability\route.ts:19–23` — as a module-level `async function` with identical body
- `D:\darshanmeel\AURA\frontend\app\page.tsx:37–40` — as an inline arrow function `const safe = async <T,>(...)`

All three implementations are identical in behaviour. A single exported function in `frontend/lib/safe.ts` would eliminate the copies.

### 4.3 `formatAge`, `formatTimestamp`, `statusColor` defined in two Observability components

`D:\darshanmeel\AURA\frontend\app\observability\LiveOverview.tsx` defines:
- `formatAge` at line 43
- `formatTimestamp` at line 52
- `statusColor` at line 79

`D:\darshanmeel\AURA\frontend\app\observability\dbt\DbtPageClient.tsx` independently defines:
- `formatAge` at line 62 (different implementation: omits the `ago` suffix, treats sub-60s as seconds not `s ago`)
- `formatTimestamp` at line 81 (same output format)
- `statusColor` at line 97 (different type signature and colour set)

`formatAge` is additionally exported from `D:\darshanmeel\AURA\frontend\lib\watcher-helpers.ts:13` and imported by `WatcherErrorsTable.tsx` and `watcher/page.tsx`. The `LiveOverview.tsx` copy does not import from `watcher-helpers.ts` despite that module existing for exactly this purpose.

The result is three versions of `formatAge` with subtly different behaviour (the `watcher-helpers.ts` version says "ago", `LiveOverview.tsx` says "ago", `DbtPageClient.tsx` omits "ago"). A newcomer reading the dbt page will see `5m 30s` while the overview page shows `5m 30s ago` for the same elapsed time.

### 4.4 `provider` CASE expression duplicated in two dbt models

The CASE expression mapping model name to provider:

```sql
CASE
    WHEN model LIKE 'claude%'  THEN 'Anthropic'
    WHEN model LIKE 'gemini%'  THEN 'Google'
    ELSE 'Other'
END
```

appears independently in:
- `D:\darshanmeel\AURA\dbt\models\marts\fact_daily_spend.sql:8–11` and `:20–24` (GROUP BY clause repeats it)
- `D:\darshanmeel\AURA\dbt\models\marts\dim_sessions.sql:187–190`

If a new provider is added (e.g. `claude-opus-5`), it would pass the `LIKE 'claude%'` check — that is fine. But a provider like `codex-mini` would need both files updated. A dbt macro `{{ provider_case('model') }}` would be the DRY fix; this is low-priority given the current two-provider scope.

---

## 5. Outdated Comments and Docstrings

### 5.1 `aura_semantic.yml` — `int_entity_spend` description contradicts the SQL

`D:\darshanmeel\AURA\dbt\models\marts\aura_semantic.yml:33` describes the `date` column:

> UTC calendar date (CAST(dim_sessions.start_ts AS DATE))

The actual SQL in `D:\darshanmeel\AURA\dbt\models\intermediate\int_entity_spend.sql:17` uses:

```sql
CAST(fmc.ts AS DATE)  AS date
```

where `fmc` is `fact_model_calls`. Cost is anchored to event timestamp, not session start. This is the intentional design (README "Cost is anchored to event timestamp, never session-start") but the YAML description says the opposite.

`D:\darshanmeel\AURA\dbt\models\marts\aura_semantic.yml:20` also says:

> 'agent' → dim_sessions.agent

The actual SQL uses `fact_model_calls.agent` (via `fmc_base.agent`), not `dim_sessions.agent`.

### 5.2 `watcher/src/aura_watcher/main.py:17–19` — comment is accurate, but `on_created` contradicts it

The comment at line 17 says `dbt_running.is_set()` short-circuit was removed. However, `on_created` at line 95 still uses it (documented in Section 2.3 above). The comment in `process_file` is accurate for `process_file` but misleads a reader into thinking the full watcher is free of the flag.

### 5.3 `snapshot.py` comment uses the old filename as a negative example

`D:\darshanmeel\AURA\watcher\src\aura_watcher\snapshot.py:13` mentions `aura_read.duckdb` as the example of what *not* to do (the old name where the catalog wouldn't match). This is accurate, but combined with `main.py:207` still defaulting to that name, it creates confusion about whether the old name was ever corrected at the call site.

### 5.4 `sources.yml` — `session_meta` columns list wrong column names

`D:\darshanmeel\AURA\dbt\models\staging\sources.yml:42–44` lists `session_meta` columns as `project_path` and `created_at`:

```yaml
columns:
  - name: project_path
  - name: created_at
```

The actual `session_meta` table schema (from `duckdb_writer.py:59–66` and `session_meta.py:46–56`) has: `session_id`, `tenant_id`, `person_id`, `person_name`, `commits`, `session_title`, `ingested_at`. Neither `project_path` nor `created_at` exist. `ingested_at` is the correct column name.

### 5.5 `CLAUDE.md` dbt interval description

`D:\darshanmeel\AURA\CLAUDE.md:1` says "performs hourly dbt rollups" but the default is 5 minutes (per `docker-compose.yml`, `main.py`, and `README.md`). The word "hourly" is stale.

---

## 6. README ↔ Code Drift

### 6.1 README says `dbt build`; watcher runs `seed`, `run`, `source freshness`, `test` separately

`README.md:157` shows:
```bash
dbt build
```

`D:\darshanmeel\AURA\watcher\src\aura_watcher\main.py:138–186` runs four separate subprocesses: `dbt seed`, `dbt run`, `dbt source freshness`, `dbt test`. The README's local dev instructions should say `dbt seed && dbt run && dbt source freshness && dbt test` (or explain that `dbt build` is the single-command equivalent that the watcher's cycle approximates, but with test failures non-blocking).

### 6.2 `AURA_READ_DB_PATH` default: README vs code

`README.md:134` says the default is `/data/read/aura.duckdb` (correct for Docker, matches `docker-compose.yml`). But the hardcoded fallback in:
- `D:\darshanmeel\AURA\watcher\src\aura_watcher\main.py:207` — `"/data/aura_read.duckdb"` (old path)
- `D:\darshanmeel\AURA\frontend\lib\db.ts:4` — `'/data/aura_read.duckdb'` (old path)

Both fallbacks diverge from the README. In Docker this is masked by the env var. In bare local dev (no Docker) the watcher and frontend would use inconsistent paths.

### 6.3 `AURA_QUERY_TIMEOUT_MS` and `AURA_ARTIFACTS_DIR` not in `docker-compose.yml`

`README.md:138–141` documents `AURA_QUERY_TIMEOUT_MS` (default `15000`) and `AURA_ARTIFACTS_DIR` (default `/data/artifacts`). Neither env var is declared in `D:\darshanmeel\AURA\docker-compose.yml`. They will use their hardcoded defaults, which happen to be correct, but the compose file is incomplete for documentation purposes.

### 6.4 `aura.toml` — README says "defined but currently ignored"

`README.md:270` says the file is "defined but currently ignored; environment variables override everything." The file at `D:\darshanmeel\AURA\aura.toml` exists with stale values. Nothing in `main.py` reads it. This is consistent with what the README says, but the file's presence is confusing: it has keys like `dbt_run_interval_minutes = 60` that differ from the actual default of 5.

### 6.5 `aura_semantic.yml` — README says MetricFlow is not wired

`README.md:271` lists "MetricFlow / dbt Semantic Layer adoption (... the frontend still queries SQL directly)" as a roadmap item. `D:\darshanmeel\AURA\dbt\models\marts\aura_semantic.yml` exists with semantic model sketches. This is consistent with what the README says — the YAML is parsed by dbt for descriptions but not for MetricFlow. The gap is that the file's `int_entity_spend` documentation is wrong (see Section 5.1).

### 6.6 README architecture diagram shows `raw_events` inside `dbt models` block

The ASCII diagram at `README.md:44` shows `raw_events` listed under "dbt models (in place)". This is technically incorrect: `raw_events` is written by the watcher to `/data/aura.duckdb`; dbt reads it but does not write it. The label "BRONZE: raw_events" inside the dbt box implies dbt manages the bronze layer, which it does not. Minor, but confusing for newcomers.

### 6.7 Dashboard page title shown as `dim_sessions` in README architecture

`README.md:56` shows `dim_sessions` in the mart list but not `int_entity_spend`, which is the primary aggregation path for range-filtered queries. For a newcomer, the architecture diagram understates the importance of `int_entity_spend`.

---

## 7. Inefficient / Overly Defensive Patterns

### 7.1 SQL string interpolation instead of parameterized queries for date filters

Multiple query functions build SQL by interpolating `since` directly into the string:

- `D:\darshanmeel\AURA\frontend\lib\queries\dashboard.ts:18` — `WHERE date >= '${since}'::DATE`
- `D:\darshanmeel\AURA\frontend\lib\queries\apps.ts:39` — `AND es.date >= '${since}'::DATE`
- `D:\darshanmeel\AURA\frontend\lib\queries\apps.ts:89` — `AND CAST(fmc.ts AS DATE) >= '${since}'::DATE`
- `D:\darshanmeel\AURA\frontend\lib\queries\agents.ts:37` — `AND es.date >= '${since}'::DATE`
- `D:\darshanmeel\AURA\frontend\lib\queries\people.ts:33` — `AND es.date >= '${since}'::DATE`

The `since` value comes from `rangeSince()` in `range.ts`, which returns either `null` or a controlled date string. Because it is not user-supplied text, SQL injection risk is minimal in practice. However, the pattern is inconsistent: `sessions.ts:26` correctly uses `params.push(since)` with a `?` placeholder, while the rest interpolate. For consistency and safety, all date filters should use parameterized form.

Additionally, some detail-page queries interpolate entity IDs that come from URL segments:

- `D:\darshanmeel\AURA\frontend\lib\queries\apps.ts:89` — `WHERE da.app_id = '${appId}'`
- `D:\darshanmeel\AURA\frontend\lib\queries\agents.ts:85` — `WHERE fmc.agent = '${name}'`
- `D:\darshanmeel\AURA\frontend\lib\queries\people.ts:76` — `WHERE ds.person_id = '${personId}'`

These entity IDs come from URL path params. While DuckDB reads a local file (so there is no network SQL injection vector), an app_id or person_id containing a single quote would cause a query error. Same-page queries that already use the parameterized API (e.g. `apps.ts:57` uses `[appId]`) should be the consistent pattern.

### 7.2 Repeated `safe()` error-swallowing without propagation to UI

The `safe()` wrapper in `dashboard/route.ts` and `page.tsx` logs to `console.error` and returns a fallback value. If a critical mart (e.g. `fact_model_calls`) fails, the dashboard silently shows zeros. There is no mechanism to surface "some data is missing" to the user. This is a deliberate choice for resilience (noted in the code), but the lack of a header-level warning leaves the user unaware when numbers are incomplete. The Observability page partially addresses this (shows dbt run failures), but the dashboard page itself gives no signal.

### 7.3 `getOverallHealth` and `getWatcherHealth` both query `raw_events` and `watcher_errors` independently

`D:\darshanmeel\AURA\frontend\lib\queries\observability.ts:58–131` and `:208–294` each open separate DuckDB connections and run near-identical queries against `raw_events` and `watcher_errors`. When the observability `view=all` endpoint is called, both functions run in parallel (line 65–72 of `route.ts`), resulting in four near-identical queries against the same two tables. The `getWatcherHealth` function is a superset of the bronze-freshness data in `getOverallHealth`; the two could share a base query.

### 7.4 `DuckDBWriter.get_connection()` opens a new connection on every call

`D:\darshanmeel\AURA\watcher\src\aura_watcher\duckdb_writer.py:11–16` — every call to `get_connection()` calls `duckdb.connect(self.db_path)` fresh. Under `_snapshot_lock`, this is safe from concurrency issues, but it means every `insert_events`, `insert_session_skills`, `log_error`, and `get_checkpoint` call opens and closes a file handle. During backfill of hundreds of files, this is thousands of open/close cycles. A persistent connection with proper locking would be more efficient, though this requires care given DuckDB's single-writer constraint.

---

## 8. dbt-Specific Cleanup

### 8.1 Two `sources` blocks both declaring `raw_events`

`D:\darshanmeel\AURA\dbt\models\staging\sources.yml` declares:

- Source `raw` (lines 4–9): declares `raw_events`, `raw_session_skills`, `session_meta` — no descriptions, no freshness rules
- Source `aura` (lines 11–70): also declares `raw_events` (with description and freshness rules), `session_meta` (with description), `ingest_checkpoints`, `watcher_errors`

`raw_events` appears in both sources. In dbt, `{{ source('raw', 'raw_events') }}` and `{{ source('aura', 'raw_events') }}` both resolve to the same physical table (`main.raw_events` per their `schema: main` declarations). The duplication creates two freshness check entries when `dbt source freshness` runs. The `raw` source block also declares `raw_session_skills` and `session_meta` without the richer metadata of the `aura` block.

The correct resolution is to merge everything into the `aura` source block and add `raw_session_skills` there. The `raw` block can then be removed. Models using `{{ source('raw', ...) }}` (notably `stg_events.sql:32`, `stg_session_meta.sql:12`) would need updating to `{{ source('aura', ...) }}`.

Models using each source:
- `{{ source('raw', 'raw_events') }}` — `dbt/models/staging/stg_events.sql:32`
- `{{ source('raw', 'raw_session_skills') }}` — `dbt/models/staging/stg_session_skills.sql` (to be verified)
- `{{ source('raw', 'session_meta') }}` — `dbt/models/staging/stg_session_meta.sql:12`

### 8.2 `sources.yml` `session_meta` column list is wrong

See Section 5.4. The `aura` source block's `session_meta` column list (`project_path`, `created_at`) does not match the actual schema (`session_id`, `tenant_id`, `person_id`, `person_name`, `commits`, `session_title`, `ingested_at`). dbt uses these declarations for documentation only (no column-level tests are attached), but they mislead anyone using `dbt docs generate`.

### 8.3 `int_entity_spend` is `materialized='table'` — this is correct

`D:\darshanmeel\AURA\dbt\models\intermediate\int_entity_spend.sql:1` — `materialized='table'`. Given that all range-filtered API queries scan this model by date, materializing as a table (with the date filter pushdown) is correct. The global config in `dbt_project.yml:28` sets `intermediate: materialized: view`, so this model's explicit override is intentional and correct.

### 8.4 `schema.yml` missing tests on key models

- `dim_people` — no tests at all in `schema.yml`. `person_id` should be `not_null` and `unique`.
- `dim_agents` — only `agent: not_null`; no `unique` test. But `dim_agents` is grain `(agent, app_id)` so a unique test would need to be composite.
- `int_entity_spend` — no tests. `(entity_type, entity_id, date)` should be a composite unique key.
- `fact_model_calls.model` — `not_null` test is declared in `schema.yml:14`. However, `fact_model_calls` joins `stg_assistant_messages` LEFT JOIN `model_pricing`, so `model` will be NULL for any `assistant` event that had no model in the JSONL payload (e.g. a synthetic event). This test may fail in practice on clean data. The `not_null` test on `calculated_cost` (line 9) has the same issue — when `mp.model IS NULL` the CASE returns NULL.

### 8.5 `coverage_test.csv` seed has only one row with model `__never_match__`

`D:\darshanmeel\AURA\dbt\seeds\coverage_test.csv` contains a single row with `model = '__never_match__'` and all costs at 0. This seed appears to exist as a guard row to satisfy the `not_null` test on `calculated_cost` by ensuring the pricing join always finds at least one row. However, the join in `fact_model_calls.sql:49–53` already uses `COALESCE(valid_to, '9999-12-31')` and would not match `__never_match__` anyway. The seed's purpose is unclear; it is not referenced in any test or model. This should either be documented or removed.

---

## 9. Newcomer Onboarding Pain Points

### 9.1 Two `package.json` files, root one is stale

A newcomer running `npm install` from the repo root would install `playwright` and `duckdb` (for the now-deleted diagnostic scripts). The root `package.json` has no build script and no `main` field. The README says to `cd frontend && npm install`, but the root file's presence suggests there is something to install at the root level.

### 9.2 `git status` is extremely noisy

Approximately 55+ untracked files in the repo root (all the `.mjs`, `.png`, `.sql`, `.md` diagnostic artifacts). A newcomer running `git status` sees an overwhelming list of untracked files before seeing any actual uncommitted changes. A `.gitignore` entry for these patterns (or deletion) is needed.

### 9.3 `frontend-engineer` agent definition describes a surface that does not exist

A developer using the Claude Code agent context will dispatch `frontend-engineer` and receive an agent that thinks it owns `streamlit/app.py`. This would result in the agent refusing to edit `frontend/` files or writing code to non-existent Streamlit files.

### 9.4 `dbt_run_interval_minutes = 60` in `aura.toml` vs actual `5`

A developer reading `aura.toml` to understand the dbt cycle would conclude it runs every hour. The actual cycle is every 5 minutes (the whole "live dashboard updates every 5 min" user story depends on this). Because the file is currently ignored by the watcher, this causes no runtime harm, but it sets wrong expectations.

### 9.5 Default DB paths differ between Docker and bare Python

The `AURA_READ_DB_PATH` default in `main.py` and `db.ts` is `/data/aura_read.duckdb` (old path). The Docker compose passes `/data/read/aura.duckdb` (new path). A developer trying to run the watcher and frontend locally without Docker will have the watcher write to `/data/aura_read.duckdb` but the frontend read from the same wrong path — and they would match each other, but neither matches the location the `snapshot.py` logic is designed for (the `read/` subdirectory serves the catalog-name constraint). The README's "Local development" section does not mention this discrepancy.

### 9.6 `watcher/tests/test_snapshot.py` tests with `aura_read.duckdb`

`D:\darshanmeel\AURA\watcher\tests\test_snapshot.py:10` — `dst = tmp_path / "aura_read.duckdb"`. This test uses the old destination name. The test may pass (it tests the copy logic, not the path), but it exercises the wrong filename convention. After the catalog-constraint fix described in `snapshot.py`, the test should use `"aura.duckdb"` as the destination basename.

---

## 10. Prioritized Cleanup Plan

| # | What to do | Why | Risk |
|---|---|---|---|
| 1 | Delete all untracked debug artifacts from repo root: `*.mjs` (35 files), `*.png` (~45 files), `today_usage.sql`, `FRONTEND_DIAGNOSIS.md`, `verify_numbers.py` | Eliminates `git status` noise; removes confusion for newcomers; no running code references any of these | **safe** |
| 2 | Delete root-level `package.json`, `package-lock.json`, and `node_modules/` | These served the now-deleted diagnostic scripts; the frontend has its own | **safe** |
| 3 | Rewrite `.claude/agents/frontend-engineer.md` to describe `frontend/` (Next.js App Router), not `streamlit/` | Agent dispatches will work correctly; the current file is entirely wrong | **safe** (docs only) |
| 4 | Update `.claude/agents/runner.md`, `data-engineer.md`, `dbt-expert.md`, `code-reviewer.md`, and `CLAUDE.md` to replace every `streamlit/` reference with `frontend/` | Keeps agent routing consistent with actual surfaces | **safe** (docs only) |
| 5 | Fix `main.py:207` default for `AURA_READ_DB_PATH` from `"/data/aura_read.duckdb"` to `"/data/read/aura.duckdb"` | Aligns bare-Python local dev with Docker default and README documentation | **needs-care** (watcher code) |
| 6 | Fix `frontend/lib/db.ts:4` default for `DB_PATH` from `'/data/aura_read.duckdb'` to `'/data/read/aura.duckdb'` | Same as above for the frontend | **needs-care** (frontend code) |
| 7 | Fix `sources.yml` `session_meta` column list to match the actual schema (`session_id`, `tenant_id`, `person_id`, `person_name`, `commits`, `session_title`, `ingested_at`), and consolidate the two `sources` blocks into one | Correct dbt docs; removes duplicate `dbt source freshness` checks | **needs-care** (dbt — cordial confirmation required) |
| 8 | Fix `aura_semantic.yml` `int_entity_spend` descriptions: `date` should say "event timestamp date (`CAST(fmc.ts AS DATE)`)", `agent` should say "from `fact_model_calls.agent`" | Prevents the docs from contradicting the cost-anchoring design | **safe** (docs only; no SQL change) |
| 9 | Fix `on_created` handler (`main.py:95`) to remove the `dbt_running.is_set()` guard, matching the stated intent of the `process_file` comment | Ensures `session_meta` is written for new JSONL files even during a dbt cycle | **needs-care** (watcher code) |
| 10 | Extract `tsFilter` and `andTsFilter` into a shared `frontend/lib/queries/_helpers.ts`; export `safe<T>` from a shared module | Reduces duplication in five query files; `safe()` in three files | **needs-care** (frontend refactor; all query files need import update) |
| 11 | Move `formatAge` / `formatTimestamp` in `LiveOverview.tsx` to use the exported version from `watcher-helpers.ts`; align `DbtPageClient.tsx` with that same module | Three divergent implementations; `DbtPageClient.tsx` omits the "ago" suffix differently | **needs-care** (frontend UI) |
| 12 | Delete or update `aura.toml` — either wire it up or delete it and update `README.md` roadmap | Eliminates the stale `dbt_run_interval_minutes = 60` and `aura_read.duckdb` confusion | **safe** |
| 13 | Add `not_null` + `unique` tests to `schema.yml` for `dim_people.person_id` and composite unique on `int_entity_spend (entity_type, entity_id, date)` | Fills gaps in the test coverage the README roadmap calls out | **needs-care** (dbt tests) |
| 14 | Replace string-interpolated entity IDs in `apps.ts:89`, `agents.ts:85`, `people.ts:76` with parameterized `?` bindings | Defensive hardening; prevents query errors on IDs containing single quotes | **needs-care** (frontend query changes) |
| 15 | Delete the three `.gitkeep` files in `dbt/models/staging/`, `dbt/models/intermediate/`, `dbt/models/marts/` | Each directory has real SQL files now | **safe** |
