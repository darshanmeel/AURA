# Aura — Code Review & Improvement Notes

**Date:** 2026-05-24  
**Scope:** Full codebase — watcher (Python), dbt models (SQL), frontend (Next.js/TypeScript), deployment config  
**Status:** Review only — no code changed

---

## Summary

Aura is well-structured for a v0 local tool: the three-tier pipeline (watcher → dbt → frontend) is clean, the data model is sound, and the UI is coherent. The issues below are not blockers for personal use, but several would become blockers at even modest scale or when sharing with a second user.

Issues are grouped by severity: **Critical** (data incorrect or system breaks), **High** (real risk, should fix before sharing), **Medium** (quality debt), **Low** (cleanup).

---

## 1. Critical Issues

### 1.1 `fact_prompts.sql` uses correlated subqueries — will not scale

**File:** `dbt/models/marts/fact_prompts.sql`

The `spans` CTE contains **seven correlated scalar subqueries**, each of the form:

```sql
(SELECT ... FROM fact_turns ft
 WHERE ft.session_id = w.session_id
   AND ft.tenant_id  = w.tenant_id
   AND ft.assistant_ts >= w.prompt_ts
   AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
 ORDER BY ft.assistant_ts LIMIT 1)
```

DuckDB executes one of these per row in `windowed`. With 1 000 prompts and 7 subqueries, that is 7 000 scans of `fact_turns`. With 50 000 prompts it becomes 350 000 scans.

**Fix approach:** Collapse all seven into a single CTE that `JOIN`s `fact_turns` into the span window using a range join or `ASOF JOIN`, then aggregates once:

```sql
-- Rough sketch
span_agg AS (
    SELECT
        w.prompt_id,
        COUNT(*)                           AS turn_count,
        COALESCE(SUM(ft.calculated_cost),0) AS cost_total,
        ...
    FROM windowed w
    JOIN fact_turns ft
      ON ft.session_id   = w.session_id
     AND ft.assistant_ts >= w.prompt_ts
     AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
    GROUP BY w.prompt_id
)
```

The same fix applies to `with_agent_and_app` (one more correlated subquery for `agent`).

---

### 1.2 `redact.py` is defined but never called

**File:** `watcher/src/aura_watcher/redact.py`, `watcher/src/aura_watcher/main.py:34`

`redact_content()` exists and has working regex logic for secrets and base64 blobs, but it is never imported or called in `main.py`. Raw payloads — including any API keys or tokens the user typed into Claude — are stored verbatim in `raw_events.payload`.

```python
# main.py line 33-34 — redact.py is never imported
raw = json.loads(line.decode('utf-8'))
event = adapter.parse_line(raw, file_path, offset)  # raw goes straight in
```

**Fix:** Import and call `redact_content` on the payload string before `json.dumps(raw)` in `claude.py`:

```python
from aura_watcher.redact import redact_content
...
"payload": redact_content(json.dumps(raw))
```

---

### 1.3 `dbt_active` flag is not thread-safe

**File:** `watcher/src/aura_watcher/main.py:72–126`

`dbt_active` is a bare module-level `bool`. The snapshot worker reads it, the dbt worker writes it — both from separate `threading.Thread` instances — without a lock. On CPython the GIL makes this unlikely to corrupt, but the read-modify-write pattern is still logically racy: the snapshot worker could read `False`, then the dbt worker sets `True`, and the snapshot runs during an active dbt build, causing a DuckDB lock conflict.

```python
dbt_active = False   # line 72 — no lock, no Event

def snapshot_worker(src, dst, interval):
    if dbt_active:    # read races with dbt_worker's write
        ...
```

**Fix:** Replace with `threading.Event`:

```python
dbt_running = threading.Event()

# dbt_worker: dbt_running.set() / dbt_running.clear()
# snapshot_worker: if dbt_running.is_set(): continue
```

---

### 1.4 Hard-coded person fallback in two places

**Files:** `watcher/src/aura_watcher/session_meta.py:63`, `dbt/models/marts/dim_sessions.sql:142–143`

```python
# session_meta.py
person_name = person_info.get("name", "Darshan Meel")  # hard-coded
```

```sql
-- dim_sessions.sql
COALESCE(sm.person_id,   'darshan')       AS person_id,
COALESCE(sm.person_name, 'Darshan Meel')  AS person_name,
```

Any user who clones this repo and has no `~/.aura/people.json` will have their sessions attributed to "Darshan Meel". This is a correctness bug for the multi-user use case.

**Fix in session_meta.py:** Fall back to `getpass.getuser()` for both id and name (it is already used for `person_id`):

```python
person_name = person_info.get("name", getpass.getuser())
```

**Fix in dim_sessions.sql:** Use `sm.person_id` without a literal fallback; let `NULL` propagate and handle it in the UI.

---

### 1.5 `session_meta` bypasses dbt's ref() graph

**File:** `dbt/models/marts/dim_sessions.sql:109–112`

```sql
session_meta_lookup AS (
    SELECT session_id, person_id, person_name, commits
    FROM session_meta   -- raw table, not a ref()
)
```

This means:
- dbt lineage is broken (the DAG does not know `dim_sessions` depends on `session_meta`).
- If the table is ever renamed or moved, dbt will fail at runtime, not at compile time.
- dbt tests cannot assert against this join.

**Fix:** Create a `stg_session_meta.sql` staging model and use `{{ ref('stg_session_meta') }}`.

---

## 2. High Priority Issues

### 2.1 Project ID decoding in claude.py is wrong for most paths

**File:** `watcher/src/aura_watcher/adapters/claude.py:42–43`

```python
decoded_proj = encoded_proj.replace("--", ":\\").replace("-", "\\")
```

Claude Code encodes project paths as: `/home/user/myproject` → `-home-user-myproject`. The encoding is single-dash for `/`, double-dash for a literal dash in the original path.

The current decode applies `replace("--", ":\\")` (colon + backslash, a Windows drive letter pattern) before `replace("-", "\\")`. For a path like `-home-user-myproject`, the result is `\home\user\myproject` — which is wrong on Linux (double backslashes) and will never match `cwd` values from sessions.

The actual mapping `dim_apps.sql` uses is the `cwd` field, not the decoded project_id from the file path. The `project_id` column in `raw_events` is only used as a fallback and is probably always wrong.

**Fix:** Either decode correctly (`replace("--", "§DASH§").replace("-", "/").replace("§DASH§", "-")`) or — better — drop the `project_id` derivation from the file path entirely and rely solely on `cwd` → `dim_apps` resolution, which already works correctly.

---

### 2.2 `db.ts` opens a new connection per query and never pools

**File:** `frontend/lib/db.ts:17`

```typescript
const conn = await db.connect()   // new connection every call
try {
    ...
} finally {
    conn.closeSync()
}
```

The DuckDB instance is a singleton, but a new connection object is created and destroyed for every `query()` call. Under concurrent Next.js server-component renders (which happen on every page load), this creates connection churn and can hit DuckDB's concurrent-reader limit.

**Fix:** Reuse a single connection per DuckDB instance, or keep a small pool (2–3 connections). Since the database is read-only, there is no isolation concern.

---

### 2.3 BigInt → Number truncation silently loses precision

**File:** `frontend/lib/db.ts:22`

```typescript
typeof v === 'bigint' ? Number(v) : v
```

`Number(BigInt)` silently rounds any integer larger than 2^53 (9 007 199 254 740 992). Token counts are unlikely to exceed this, but `byte_offset` in checkpoints and raw `uuid` integers could. The conversion produces no warning.

**Fix:** Use `String(v)` for values that are identifiers (UUIDs, offsets), and `Number(v)` only for aggregates where rounding is acceptable. Or use the `json-bigint` serializer.

---

### 2.4 `on_created` does not call `write_session_meta` on backfill

**File:** `watcher/src/aura_watcher/main.py:148–151`

```python
# Initial Backfill
files = glob.glob(os.path.join(logs_dir, "**", "*.jsonl"), recursive=True)
for f in files:
    process_file(f, writer, adapter, cp_manager)  # no write_session_meta call
```

`write_session_meta` is only called in `on_created` (the watchdog handler). Existing files processed during startup backfill never get session metadata written, so `person_id`, `person_name`, and `session_title` are missing for all pre-existing sessions unless `backfill_session_meta.py` is run manually.

**Fix:** Call `write_session_meta` during the backfill loop for any `session_id` not already in `session_meta`.

---

### 2.5 `datetime.utcnow()` is deprecated

**File:** `watcher/src/aura_watcher/session_meta.py:72`

```python
datetime.utcnow()   # deprecated in Python 3.12, removed in 3.14
```

Python 3.12 emits a `DeprecationWarning` and future Python will raise `AttributeError`.

**Fix:**
```python
from datetime import datetime, UTC
datetime.now(UTC)
```

---

### 2.6 `int_turns.sql` only looks 4 blocks deep for text content

**File:** `dbt/models/intermediate/int_turns.sql:17–27`

```sql
COALESCE(
    json_extract_string(u.payload, '$.message.content[0].text'),
    json_extract_string(u.payload, '$.message.content[1].text'),
    json_extract_string(u.payload, '$.message.content[2].text'),
    json_extract_string(u.payload, '$.message.content[3].text'),
    ...
)
```

Claude Code sends `thinking` blocks, `tool_result` blocks, and `text` blocks in content arrays. A prompt preceded by 4+ tool results will have its text at index 4 or beyond, producing `NULL` for `user_prompt` — meaning it will never appear in `fact_prompts` and the session's title will fall back to the session ID.

**Fix:** Use DuckDB's `json_extract` with a `list_filter` approach or unnest and filter by `type = 'text'`:

```sql
-- More robust: extract all text blocks and take the first non-empty one
list_first(
    list_filter(
        json_transform(u.payload, '{"message": {"content": [{"type": "VARCHAR", "text": "VARCHAR"}]}}').message.content,
        x -> x.type = 'text' AND x.text IS NOT NULL AND x.text != ''
    )
).text  AS user_prompt
```

---

### 2.7 Model context windows are hard-coded and will go stale

**File:** `watcher/src/aura_watcher/adapters/claude.py:6–14`

```python
MODEL_CONTEXT_WINDOWS = {
    "claude-3-5-sonnet-20241022": 200000,
    "claude-opus-4-7": 200000,
    ...
}
```

Any new model (e.g., `claude-sonnet-4-7`) silently falls back to 200 000 (the default), which may be incorrect. There is also no way to update this without a code change.

**Fix:** Add a `context_window` column to `model_pricing.csv` (it is already there — `context_window` exists in the seed) and look it up from there. The watcher can query DuckDB at startup for the lookup table, or default to 200 000 with a log warning for unknown models.

---

## 3. Medium Priority Issues

### 3.1 `SessionTabs.tsx` is 800+ lines — should be split

**File:** `frontend/components/SessionTabs.tsx`

All nine tabs (Turns, Messages, Prompts, Agents, Errors, Files, Tokens, Tools, Git) are implemented as inline components or large `if` blocks inside a single 800-line file. Each tab has its own state, filtering logic, and rendering tree.

This makes it hard to:
- Read: you have to scroll past 400 lines to find the Files tab.
- Test: there is no way to render one tab in isolation.
- Maintain: a change to the Errors tab risks accidentally affecting the Tokens tab.

**Fix:** Extract each tab into `components/tabs/TurnsTab.tsx`, `MessagesTab.tsx`, etc. `SessionTabs.tsx` becomes a thin router that renders the active tab component.

---

### 3.2 `adapters/base.py` stub is not used

**File:** `watcher/src/aura_watcher/adapters/base.py`

The file defines an adapter interface (11 lines) but `ClaudeAdapter` does not inherit from it and the base class has no method signatures — it's effectively a comment.

**Fix:** Either:
- Delete it (until a second adapter is actually needed), or
- Turn it into a proper `Protocol` or `ABC` with `parse_line()` and `parse_skills()` signatures that `ClaudeAdapter` implements.

---

### 3.3 Snapshot worker silently swallows all errors

**File:** `watcher/src/aura_watcher/main.py:85–87`

```python
except Exception as e:
    # Locking errors are expected if the backfill is busy
    pass
```

This catches and discards every exception — including disk full, permission denied, and corrupted database errors. A user would have no idea why the read replica stopped updating.

**Fix:** At minimum log the exception:
```python
except Exception as e:
    print(f"[snapshot] Warning: {e}")
```
For lock errors specifically (common), you can suppress at `DEBUG` level. For others, log at `WARNING`.

---

### 3.4 Skills parsing error is silently swallowed

**File:** `watcher/src/aura_watcher/main.py:42–46`

```python
try:
    skills = adapter.parse_skills(raw, file_path)
    if skills:
        writer.insert_session_skills(skills)
except Exception as e:
    pass
```

No log, no counter, no way to know if skills are failing to parse. The `raw` variable is also referenced here from the outer loop even when the line failed to parse (if `json.loads` raised, `raw` is undefined from a previous iteration).

**Fix:** Log the exception. Also restructure so `parse_skills` is only called when `raw` is successfully parsed.

---

### 3.5 `getTopProjects()` does a client-side join that could be SQL

**File:** `frontend/lib/queries/dashboard.ts:56–76`

```typescript
const [projects, apps] = await Promise.all([query(...)], query(...)])
return projects.map((p: any) => ({
    ...p,
    apps: apps.filter((a: any) => a.project_id === p.project_id)...
}))
```

Two round-trips to DuckDB followed by a JavaScript join. This works fine at small scale but adds latency and moves work that DuckDB does better (sorted JOIN, GROUP BY) into the application layer.

**Fix:** Use a single query with a `LIST` aggregate:

```sql
SELECT
    p.*,
    LIST(struct_pack(
        app_id    := a.app_id,
        app_name  := a.app_name,
        total_cost := a.total_cost
    ) ORDER BY a.total_cost DESC)  AS apps
FROM dim_projects p
LEFT JOIN dim_apps a USING (project_id, tenant_id)
GROUP BY ALL
ORDER BY p.total_cost DESC
LIMIT 10
```

---

### 3.6 Hard-coded LIMIT values throughout query files

**Files:** `frontend/lib/queries/dashboard.ts`, `sessions.ts`, `apps.ts`, `agents.ts`

Limits like `LIMIT 10`, `LIMIT 12`, `LIMIT 14`, `LIMIT 50`, `LIMIT 200` are scattered as literals inside SQL strings. There is no single place to tune them, and some (like `LIMIT 200` on sessions) were discovered to cause correctness issues (truncated totals on the sessions page).

**Fix:** Define constants at the top of each query file or in a shared `lib/limits.ts`:

```typescript
const DASHBOARD_TOP_N = 10
const SESSIONS_PAGE_SIZE = 50
const SESSIONS_STATS_CAP = 1000
```

---

### 3.7 No query timeout or cancellation in `db.ts`

**File:** `frontend/lib/db.ts`

A slow query (e.g., `fact_prompts` before the correlated subquery fix) will block the Next.js server thread indefinitely. There is no timeout, no cancellation, and no way for a user refresh to abort an in-flight query.

**Fix:** Wrap `runAndReadAll` in a `Promise.race` with a configurable timeout, or use DuckDB's query cancellation API if available in `@duckdb/node-api`.

---

### 3.8 `dim_sessions.sql` groups by `model` before aggregating — loses mixed-model sessions

**File:** `dbt/models/marts/dim_sessions.sql:22`

```sql
GROUP BY tenant_id, session_id, model, cwd, project_id, git_branch, claude_version
```

`session_stats` groups by `model`, so a single session that switches models mid-session (e.g., starts with Sonnet, then spawns a Haiku subagent) produces **multiple rows** in `session_stats`. The `aggregated_sessions` CTE then uses `ANY_VALUE(model)` to collapse them — which picks an arbitrary model. The session's "primary model" is effectively random.

**Fix:** Use `MODE()` or `FIRST(model ORDER BY assistant_ts)` instead of `ANY_VALUE`, and remove `model` from the first `GROUP BY` so the aggregation happens in one step.

---

### 3.9 `fact_session_files.sql` — proportional attribution can produce fractional tokens

**File:** `dbt/models/marts/fact_session_files.sql`

The model divides per-turn token counts by the number of files touched in that turn (`1/k`). If a turn touches 3 files, each gets 0.333… of the tokens. These fractions are stored as floats and summed later, which can produce non-integer token counts in the UI (e.g., "1.667 tokens").

**Fix:** Either round at storage time or display as integers in the frontend with `Math.round`.

---

### 3.10 `docker-compose.yml` has no health checks or resource limits

**File:** `docker-compose.yml`

- No `healthcheck` on either service — Docker cannot restart an unhealthy container automatically.
- No `mem_limit` — the watcher can consume unbounded memory on large backlogs.
- `restart: unless-stopped` on the watcher will retry a crashing container indefinitely, potentially spamming logs.

**Fix example:**
```yaml
watcher:
  healthcheck:
    test: ["CMD", "python", "-c", "import os; exit(0 if os.path.exists('/data/aura_read.duckdb') else 1)"]
    interval: 30s
    timeout: 5s
    retries: 3
  deploy:
    resources:
      limits:
        memory: 512M
```

---

## 4. Low Priority / Code Hygiene

### 4.1 `backfill_session_meta.py` duplicates session_meta logic

**File:** `backfill_session_meta.py` (repo root)

This script duplicates `_extract_session_title` and the `session_meta` table DDL from `watcher/src/aura_watcher/session_meta.py`. Any change to the title extraction algorithm must be made in two places.

**Fix:** Import from `aura_watcher.session_meta` rather than re-implementing.

---

### 4.2 `aura.toml` is defined but not read by any code

**File:** `aura.toml`

The file defines paths, intervals, and framework config, but nothing reads it — all config comes from environment variables. Either wire it up (e.g., with `tomllib` in Python 3.11+) or remove it to avoid confusion.

---

### 4.3 Frontend uses `any` everywhere — no type safety in query results

**Files:** `frontend/app/*.tsx`, `frontend/lib/queries/*.ts`

Nearly every query result is cast to `any` before use:

```typescript
const kpis = data.kpis as any
const sessions = data.sessions as any[]
```

The generic `query<T>()` function exists but `T` is never provided — every call uses the default `Record<string, unknown>` and immediately casts to `any`.

**Fix:** Define TypeScript interfaces for each query's return shape and pass them as the generic parameter:

```typescript
interface SessionRow {
    session_id: string
    start_ts: string
    total_cost: number
    turn_count: number
    ...
}
const sessions = await query<SessionRow>(sql)
```

---

### 4.4 Page-level `try { ... } catch {}` masks all database errors

**File:** `frontend/app/page.tsx:33`, `frontend/app/apps/[appId]/page.tsx:53–68`

```typescript
try {
    const [a, s, ag, pr, allPr] = await Promise.all([...])
    ...
} catch {}
```

An empty catch means any query error (bad SQL, missing table, DB not found) renders the page as if there were simply no data. During development this makes bugs invisible.

**Fix:** Log to `console.error` at minimum. In the app detail page, only swallow errors for tables that are known to be optional (like `dim_agents`); let hard failures from core tables propagate to Next.js's error boundary.

---

### 4.5 `model_pricing.csv` has no `valid_to` end dates

**File:** `dbt/seeds/model_pricing.csv`

All rows have `valid_to` as empty/null (open-ended). When Anthropic changes pricing for an existing model, there is no way to represent the old and new rates simultaneously — inserting a new row would create two open-ended rows for the same model, and the pricing join would pick arbitrarily.

**Fix:** Add an end date when superseding a price row. The join in `fact_model_calls.sql` already has `valid_from <= mc.ts AND (valid_to IS NULL OR valid_to > mc.ts)` logic ready for this.

---

### 4.6 Test coverage is very thin

**Files:** `watcher/tests/`

Five test files covering roughly 85 lines of tests for ~600 lines of production code. The happy-path cases are tested, but:
- No test for `process_file` with a malformed JSONL line.
- No test for `snapshot.py` failure modes (disk full, file locked).
- No test for `ClaudeAdapter` with an unknown model (should default context_pct gracefully).
- No test for the project_id decoding logic (which is currently wrong — see 2.1).
- No integration test that runs the full watcher → DuckDB → dbt chain.

---

### 4.7 `stg_tool_results.sql` has two code paths that are hard to maintain

**File:** `dbt/models/staging/stg_tool_results.sql`

The model UNIONs two completely different extraction strategies for tool results (one from nested `content` arrays in user events, another from a top-level `toolUseResult` field in assistant events). This reflects a real schema inconsistency in Claude Code's JSONL format, but the two paths have different column availability, making the UNION fragile if new fields are added to one path and not the other.

**Fix:** Document clearly which JSONL event types each branch handles, and add a `source_path` column (`'content_array'` vs `'tool_use_result'`) so downstream models can filter if needed.

---

## 5. Potential Future Work (Not Bugs)

These are not improvements to existing code — they are capabilities the architecture is ready for but not yet built.

| Item | Why it matters |
|---|---|
| **Gemini adapter** | Architecture has `adapters/base.py` placeholder; `model_pricing.csv` already has Gemini rows |
| **Multi-tenant auth** | `tenant_id` is plumbed everywhere in the schema but always `'local'`; adding auth + row-level security is straightforward |
| **Column masking before central sync** | Privacy requirement documented in `redact.py` and README; implementation not started |
| **dbt tests** | No `.yml` schema tests on any mart; add `not_null`, `unique`, `relationships` tests for primary keys |
| **`aura.toml` wiring** | Config file exists but is ignored; wiring it would allow users to change paths/intervals without editing environment variables |
| **Dashboard caching** | All API routes re-query DuckDB on every request; Next.js `revalidate` or ISR could cache results for the snapshot interval (default 2s) |

---

## File Quick Reference

| File | Lines | Key concern |
|---|---|---|
| `watcher/src/aura_watcher/main.py` | 172 | Thread-safety, silent error swallowing, backfill missing session_meta |
| `watcher/src/aura_watcher/adapters/claude.py` | 117 | Wrong project_id decoding, hard-coded model windows, redact not called |
| `watcher/src/aura_watcher/session_meta.py` | 73 | Hard-coded person name, deprecated `utcnow()`, duplicate DDL |
| `watcher/src/aura_watcher/redact.py` | 27 | Implemented but never integrated |
| `dbt/models/marts/fact_prompts.sql` | 243 | 7 correlated subqueries — performance timebomb |
| `dbt/models/marts/dim_sessions.sql` | 162 | Raw `session_meta` table reference, hard-coded person fallback, `ANY_VALUE(model)` |
| `dbt/models/intermediate/int_turns.sql` | 51 | Only searches 4 content blocks deep |
| `frontend/lib/db.ts` | 34 | New connection per query, BigInt truncation |
| `frontend/components/SessionTabs.tsx` | 800+ | Monolithic — all tabs in one file |
| `frontend/app/page.tsx` | 424 | Silent catch hides all DB errors |
| `docker-compose.yml` | 33 | No health checks, no resource limits |
