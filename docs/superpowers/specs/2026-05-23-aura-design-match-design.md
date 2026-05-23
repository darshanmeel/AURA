# AURA — Match `AURA_Design_extracted` exactly

**Date:** 2026-05-23
**Author:** Claude (Opus 4.7, planning) → handoff to Sonnet/Haiku for implementation
**Status:** Draft for user approval
**Scope:** Make `localhost:3000` match every screen in `C:\Users\Acer1\Downloads\AURA_Design_extracted\AURA\screenshots\01..09`, and extend the data model so the user can drill **tokens and time per file**, **per prompt**, and **per agent within app**, and see **model-overkill flags**.

---

## 1. Guiding constraints (from user)

1. **Design parity** is non-negotiable: layout, ledgers, side panels, hero, KPI strips, and prompts walk must match the screenshots.
2. **Drill tokens & time as low as possible**: per file, per prompt, per agent-in-app.
3. **Model-overkill flag**: surface when a heavyweight model was used for a trivial task.
4. **Agent attribution by (agent_name, app)**: same `lead-engineer` in two apps = two rows.
5. **No explicit agent → `"main"`** (the default Claude Code session, no Task delegation).
6. **People = ignore**: leave the page but de-emphasize (1 operator today).

---

## 2. Current state (what's already working, do not touch)

- `raw_events` schema captures `model`, all token slices, `cache_creation.{ephemeral_5m,ephemeral_1h}`, `cwd`, `gitBranch`, `version`, `parent_uuid`, `request_id`, `message_id`, `is_sidechain`, `stop_reason`, `context_pct`, full `payload`. **Sufficient for everything below.**
- `fact_tool_executions` joins tool_calls ↔ tool_results with `execution_duration_seconds` and `is_error`. **Use as the source of truth for tool work and duration.**
- `fact_model_calls` computes per-assistant-call cost from `model_pricing` seed. **Cost source.**
- Next.js shell, masthead, footer, hero layout, `styles/globals.css` design tokens, `components/atoms.tsx` (Eyebrow, StatBlock, ModelPill, ProviderTag, AgentLink, etc.) — all already match the design. **No CSS rework needed.**

---

## 3. Watcher changes (`watcher/src/aura_watcher/`)

### 3.1 Agent attribution — the big one
**Problem:** `adapters/claude.py:65` hard-codes `"agent": "claude"`. Design needs real subagent names (`lead-engineer`, `frontend-engineer`, etc.), and you said "if no agent name, it's main."

**Source in JSONL:** When Claude Code delegates via the `Task` tool, the parent assistant message contains a `tool_use` block:
```json
{"type":"tool_use","id":"toolu_...","name":"Task",
 "input":{"description":"...","subagent_type":"lead-engineer","prompt":"..."}}
```
All subsequent events with `isSidechain=true` whose `parent_uuid` chain traces to that `toolu_...` belong to that subagent.

**Implementation (two-pass, no schema change yet):**

1. **First pass (existing):** keep ingesting raw events with `agent="claude"` placeholder.
2. **New mart `int_event_agent` (dbt staging):**
   ```sql
   -- Find every Task tool_use → (tool_use_id, subagent_type)
   WITH task_dispatches AS (
     SELECT tool_use_id, json_extract_string(input_payload, '$.subagent_type') AS subagent_type
     FROM stg_tool_calls
     WHERE tool_name IN ('Task','Agent')
   ),
   -- Walk parent_uuid chain on sidechain events back to a tool_use_id
   -- (recursive CTE; DuckDB supports WITH RECURSIVE)
   sidechain_roots AS (
     -- the user-message that immediately follows a Task tool_result; its
     -- parent_uuid is the assistant message that issued the Task, but its
     -- toolUseResult.tool_use_id is the dispatching toolu_…
     ...
   )
   SELECT e.uuid, COALESCE(td.subagent_type, 'main') AS agent_resolved
   FROM stg_events e LEFT JOIN ...
   ```
3. **Replace `agent` column reads** in downstream marts with `agent_resolved`. The raw column stays `"claude"` (placeholder), but every mart selects `agent_resolved`.

**Alternative (simpler, ship first):** patch `claude.py` to inline-parse `subagent_type` on each event by walking *backwards through the file's events as it processes them*. Keep a per-session in-memory `{parent_uuid → subagent_type}` map and stamp `agent` directly on insert. Trade-off: backfill rewrites are needed if the rule changes; the dbt approach is idempotent.

**Recommendation:** ship the dbt approach (idempotent, re-runnable). Watcher continues stamping `"claude"`; dbt resolves the agent name at staging.

### 3.2 No other watcher changes required for v1
Everything else the design needs is already in `raw_events`.

---

## 4. dbt changes (`dbt/models/`)

### 4.1 New mart: `int_event_agent` (intermediate)
Resolves `(session_id, event_uuid) → agent` per §3.1 above. Default `"main"`.

### 4.2 New mart: `dim_projects` & `dim_apps` (hierarchical, derived from cwd)
**Project** = top of a repo. **App** = nested directory under `apps/`, `services/`, or `packages/` (configurable list).

```sql
-- dim_apps.sql (regenerated)
WITH paths AS (
  SELECT DISTINCT cwd FROM stg_events WHERE cwd IS NOT NULL
),
parsed AS (
  SELECT
    cwd,
    -- split on \ or /
    regexp_split_to_array(replace(cwd, '\', '/'), '/') AS parts
  FROM paths
),
classify AS (
  SELECT
    cwd,
    parts,
    -- find 'apps' / 'services' / 'packages' segment
    list_position(parts, 'apps') AS apps_idx,
    list_position(parts, 'services') AS svc_idx,
    list_position(parts, 'packages') AS pkg_idx
  FROM parsed
)
SELECT
  cwd                                                          AS cwd,
  CASE
    WHEN apps_idx IS NOT NULL THEN parts[apps_idx + 1]
    WHEN svc_idx  IS NOT NULL THEN parts[svc_idx + 1]
    WHEN pkg_idx  IS NOT NULL THEN parts[pkg_idx + 1]
    ELSE parts[len(parts)]
  END                                                          AS app_id,
  CASE
    WHEN apps_idx IS NOT NULL THEN array_slice(parts, 1, apps_idx - 1)
    WHEN svc_idx  IS NOT NULL THEN array_slice(parts, 1, svc_idx - 1)
    WHEN pkg_idx  IS NOT NULL THEN array_slice(parts, 1, pkg_idx - 1)
    ELSE array_slice(parts, 1, len(parts) - 1)
  END                                                          AS project_path_parts,
  ...                                                          AS project_id
FROM classify
```
Result: `D:\darshanmeel\crosshire\apps\fitscore` → `project_id="crosshire"`, `app_id="fitscore"`. `D:\darshanmeel\AURA` → `project_id="AURA"`, `app_id="AURA"`.

### 4.3 New mart: `fact_prompts` (the per-prompt rollup)
**Purpose:** for each external user prompt, walk forward until the next external user prompt (or session end) and aggregate everything that happened in that span. This is the row behind the design's "Prompts & responses" section.

Columns:
- `tenant_id, session_id, prompt_id` (uuid of the user event), `prompt_ts`, `prompt_text`, `prompt_input_tokens` (rough: char-count/4)
- `next_prompt_ts` (NULL for last in session)
- `agent` (resolved via §4.1 — usually "main" unless this prompt is inside a sidechain; sidechains rarely contain external prompts but if so, the subagent name)
- `app_id`, `project_id` (joined from dim_apps)
- `model_primary` (the model used by the **first** assistant turn in span — overkill check anchor)
- `turn_count`, `tool_call_count`, `files_edited`, `output_tokens_total`, `cost_total`, `duration_seconds`, `errors_caught`, `tools_used_json` (JSON array of `{name, count}`)
- `summary` (first sentence of last assistant message in span)
- **Overkill columns (see §4.4):** `complexity_tier`, `expected_model_tier`, `actual_model_tier`, `is_overkill`, `overkill_reason`

### 4.4 Overkill heuristic (per `fact_prompts`)
Tier-matrix approach:

| Signal | Bucket → tier |
|---|---|
| `prompt_input_tokens` | `<100`→S, `<400`→M, `<1500`→L, else XL |
| `tool_call_count` in span | `0`→S, `<5`→M, `<20`→L, else XL |
| `files_edited` in span | `0`→S, `<3`→M, `<8`→L, else XL |
| keywords in prompt | `refactor|architecture|design|spec|migrate` → +1 tier (cap XL) |

`complexity_tier` = `MAX(bucket_signals)`.

| `complexity_tier` | Expected model tier |
|---|---|
| S | haiku |
| M | sonnet / gemini-flash |
| L | sonnet / gemini-pro |
| XL | opus / gemini-pro |

`actual_model_tier` derived from `model_primary` (claude-haiku-* → 0, claude-sonnet-* → 1, gemini-2.5-flash → 1, gemini-2.5-pro → 2, claude-opus-* → 2).

`is_overkill = actual_tier > expected_tier + 0`. `overkill_reason` = templated text: `"Opus on S-tier task: 84 input tokens, 0 tool calls, 0 files."`.

### 4.5 Extend `fact_session_files` for per-file tokens + duration
Add columns to existing mart (do **not** replace edit_count):

- `tokens_attributed` — proportional split of the dispatching turn's `output_tokens` across files touched in that turn
- `duration_attributed_seconds` — proportional split of the assistant→tool_result duration
- `cost_attributed` — proportional split of `calculated_cost`

Implementation: join `fact_tool_executions` ↔ `fact_model_calls` on `assistant_event_uuid`, count files-touched-in-turn = `k`, attribute `1/k` of each metric per file row.

### 4.6 New mart: `fact_files` (cross-session)
Rolls `fact_session_files` up by `(project_id, app_id, file_path)` for the dashboard's "Files — most edited" + future Top-N-files-by-cost views.

### 4.7 Refresh `dim_sessions` to use resolved agent
Change `agent_per_session`'s `ANY_VALUE(agent)` to **list_distinct of resolved agent**. A session with 3 subagents in rotation should expose `agents = ['main', 'lead-engineer', 'data-engineer']` (an array column). The `agent` scalar stays for back-compat but represents "primary agent" (mode).

### 4.8 New mart: `dim_agents`
`(agent, project_id, app_id) → sessions, turns, tool_calls, cost, tokens, errors`. This is the (agent × app) tuple you asked for — the same `frontend-engineer` in `fitscore` and `aura` becomes two rows.

---

## 5. Frontend changes (`frontend/`)

Working from the existing structure — chrome and tokens are correct, mostly query/render gaps.

### 5.1 Dashboard (`app/page.tsx`)
- **Hero KPI sparkline:** wire `dailySpend` into the existing `DailyChart` (currently passing empty `[]`). Confirm `fact_daily_spend` returns rows; if it doesn't, the dbt schedule needs to run first (see §7).
- **6-stat strip:** the design uses **Projected · 30d** as the last stat (`(14d_spend/14)*30`), currently shows "Total spend". Swap and add a `dailyAvg` footnote.
- **Apps ledger:** currently displays "Projects — by cost" with nested apps below. Match design: show `Apps — by cost` as a flat list (one row per app), with `People|Agents|Sessions|Commits|Cost|Share`. Drop the project nesting from this view — Projects gets its own (optional) section.
- **Recent errors table:** wire the rest of design's "Errors — recent" row layout (When|Severity|Kind|Tool|Message|Session + arrow). Already mostly there.
- **Editor's note:** keep as a static seed file `dbt/seeds/editor_quotes.csv` rotating daily, or compute the loudest prompt of the day from `fact_prompts.prompt_text` (recommended — "with receipts" voice).

### 5.2 Apps list (`app/apps/page.tsx`)
Replace bare card grid with the design's full app cards:
- glyph (first letter, big)
- name + description (from `dim_apps`)
- owner (skip — single-person mode)
- 14-day spend
- sessions/turns/commits/errors row
- agents-in-rotation chip row (max 5, "+N" overflow)

### 5.3 App profile (`app/apps/[appId]/page.tsx`)
Implement the full screenshot 03:
- header: glyph + name + description + 14-day spend block
- 6-stat strip: sessions / people / agents / commits / tokens / errors
- **Agents in this app** table (this is the (agent × app) row from `dim_agents`)
- **Sessions — recent** ledger
- side panel: **Recent prompts in this app** (top 5 from `fact_prompts WHERE app_id = ?` ordered by `cost_total` DESC) — show prompt text in italics + meta line

### 5.4 Agent profile (`app/agents/[name]/page.tsx`)
**Currently empty — build from scratch matching screenshot 06:**
- header: hexagonal glyph + name + "serving N people in M apps" + 14-day spend + sparkline
- 6-stat strip: sessions / apps / people / tool calls / models routed to / errors
- **Apps served** table (which app, how many sessions, cost — i.e. project × agent rows)
- **Models routed to** table (this agent ran on opus 80% / sonnet 20%, by cost)
- **Sessions — recent**
- side panel: **top files this agent touches** (joins `fact_files` × `dim_agents`) + **prompts directed at this agent**

Route param can be just `name`; show all (name, app) combinations.

### 5.5 Sessions ledger (`app/sessions/page.tsx`)
Add the 5-stat strip above the table (sessions matching filters, total cost, total turns, total commits, total errors). Add `Person` column (will be "—" or omitted if you want), match column order: started · person · app · agent · title+branch · model · turns · commits · cost.

Also: replace the current `cwd?.split('/').pop()` for App display with a join on `dim_apps.app_id` so the app name is the human one.

### 5.6 Session detail (`app/sessions/[sessionId]/page.tsx`)
- **Per-turn stacked-token chart**: already a stub; wire it. Bars stack `[cacheR, cacheW, out, in]` with a context-% overlay line. Data: `fact_turns ORDER BY turn_number LIMIT 60`.
- **Turn table**: 20 rows max, with stop_reason pill, tool col, ctx_pct (warn when >70%). Data: `fact_turns`.
- **Errors · this session**: already in scope.
- **Side rail — Tokens · where**: stack-bar of [cache_read, cache_5m, cache_1h, output, fresh input] for the session.
- **Side rail — Files · this session**: now show `tokens_attributed | duration_attributed | edits` (new columns from §4.5) — this is the per-file drill you wanted.
- **Side rail — Tools · session**: bar chart from `fact_tool_executions`.
- **NEW: Prompts & responses (full width)** — design's biggest piece, currently absent. Render `fact_prompts WHERE session_id=?` with the design's wide-card layout: `#NN`, time, prompt text in quotes, then the response meta line + summary + tools chips. **Include the model pill + the overkill flag** next to each prompt — this is the per-prompt drill.

### 5.7 Errors (`app/errors/page.tsx`)
Match screenshot 09:
- 5-stat strip (total / hard / warnings / sessions affected / top failure tools)
- severity + kind chip filter row
- full table (when · severity · kind · tool · message · session+agent · turn)

### 5.8 People — leave as-is for now
Keep the page; pin a "Single-operator mode" note. No data-shape work.

---

## 6. New SQL queries (`frontend/lib/queries/`)

### 6.1 `prompts.ts` (new file)
- `getSessionPrompts(sessionId)` — for session detail prompts walk
- `getAppPrompts(appId, limit)` — for app profile side panel
- `getAgentPrompts(agentName, limit)` — for agent profile side panel
- `getOverkillPrompts(limit)` — dashboard side panel: "biggest model-overkill flags"

### 6.2 `agents.ts` (new file)
- `getAgent(agentName)` — returns rolled-up stats + per-app breakdown rows + sparkline data
- `getAgentApps(agentName)` — `dim_agents WHERE agent = ?`
- `getAgentFiles(agentName)` — top files this agent touched, from `fact_files × dim_agents`
- `getAgentModels(agentName)` — model split

### 6.3 `apps.ts` (extend)
- `getApp(appId)` — header data + 6 KPIs (sessions, people, agents, commits, tokens, errors)
- `getAppAgents(appId)` — `dim_agents WHERE app_id = ?`
- `getAppSessions(appId)` — recent sessions

### 6.4 `files.ts` (new file)
- `getSessionFilesWithAttribution(sessionId)` — file_path, tokens_attributed, duration_attributed, edit_count, write_count
- `getTopFiles(limit)` — dashboard top files (across all sessions, but now ranked by cost_attributed not just edits)

### 6.5 `errors.ts` (extend)
- `getErrorsSummary()` — the 5 KPI numbers
- `getErrorsByKind()` — chip counts
- `getErrors(filter)` — filtered table

---

## 7. Operational checks (what to verify before claiming done)

Per `CLAUDE.md`'s Karpathy principles:
1. **dbt has actually run after changes**: `docker compose exec watcher dbt build --profiles-dir .` returns success and `SELECT count(*) FROM dim_sessions` > 0.
2. **`fact_prompts` is non-empty**: `SELECT count(*), avg(turn_count), sum(is_overkill::int) FROM fact_prompts`.
3. **Agent resolution worked**: `SELECT agent, count(*) FROM dim_sessions GROUP BY agent` returns at least `main` plus subagent names you've actually used (lead-engineer, frontend-engineer, etc.).
4. **Live dashboard at localhost:3000** shows non-empty hero ($XYZ, real token count), non-empty apps ledger, at least one prompt in any session's prompts walk, and at least one overkill flag.
5. **Per-file attribution sanity**: `SELECT sum(tokens_attributed) FROM fact_session_files WHERE session_id='<X>'` ≈ `SELECT sum(output_tokens) FROM fact_model_calls WHERE session_id='<X>'` (within ±5% — depends on turns that touched zero files).

---

## 8. Out of scope (deliberately deferred)

- Tweaks panel (accent/density/showPrompts)
- People page beyond present functionality
- "Owner" labels on apps (single-operator mode)
- Real-time replay of tool inputs/outputs (design CLAUDE.md "next moves" §2)
- Sidechain analytics ("how often does this agent fan out")
- Multi-tenant (`tenant_id` is already in schema, just not exposed)

---

## 9. Implementation order (hand-off to Sonnet/Haiku)

The handoff implementer should execute in this order — each step is small, testable, and unblocks the next.

1. **dbt: `int_event_agent`** (resolve agent name) — verify with `SELECT agent_resolved, count(*) FROM int_event_agent GROUP BY 1`.
2. **dbt: `dim_apps`, `dim_projects`** rewrite using cwd parsing — verify with `SELECT * FROM dim_apps`.
3. **dbt: `dim_sessions` use resolved agent + agents array** — verify dashboard query.
4. **dbt: `fact_prompts`** — verify row counts ≈ # of `userType=external` user events.
5. **dbt: `fact_session_files` extend with attribution columns** — sanity check sums.
6. **dbt: `dim_agents`** — new mart, (agent × app).
7. **frontend: dashboard wiring** (apps ledger flat, sparkline data, 6th stat = projected 30d).
8. **frontend: session detail prompts walk + per-file attribution side panel** — the most user-visible drill.
9. **frontend: agent profile page** (new build).
10. **frontend: app profile page** fill-in.
11. **frontend: errors page** match design.
12. **frontend: sessions ledger 5-stat strip + app/agent column join**.

Each step ends with a verification query or a localhost screenshot, not "the script exit 0'd".

---

## 10. Confidence + uncertainty

- **High confidence:** chrome already matches; data model already has 90% of the underlying fields; agent resolution via `subagent_type` is mechanical.
- **Medium confidence:** the recursive CTE for sidechain → dispatching Task in `int_event_agent` — DuckDB supports `WITH RECURSIVE` but the exact join key (parent_uuid vs toolUseResult linkage) needs a 5-event inspection of a real Task-dispatching session before writing the SQL. The implementer should sample 1 such session first.
- **Lower confidence:** overkill heuristic thresholds (S/M/L/XL token cutoffs) are first-guess. Tune after looking at 20 real prompts. Keep the columns wide enough that we can re-bucket without re-ingesting.

---

## 10.5 Single-user fallback (added 2026-05-23, user request)

Until a real `session_meta` row is populated per session, every place that needs `person_id` / `person_name` should fall back to the current OS user so the UI shows real data instead of `—`. Two-layer fix:

1. **`dim_sessions.sql`** — wrap the `sm.person_*` columns in `COALESCE`:
   ```sql
   COALESCE(sm.person_id,   'darshan')      AS person_id,
   COALESCE(sm.person_name, 'Darshan Meel') AS person_name,
   ```
2. **`watcher/src/aura_watcher/session_meta.py`** — when writing the initial meta row for a new session, default `person_id` / `person_name` from the OS user (`os.getlogin()` → mapped via a small dict, fallback to the raw username). Don't overwrite existing values.

Frontend displays continue to show whatever the column returns; the fallback is a data-layer concern.

## 11. Message-text capture & display rule (added 2026-05-23)

`int_turns.sql` already extracts `user_prompt` and `assistant_response` text via `json_extract_string`. These columns must propagate through every new mart (`fact_prompts`, future `fact_messages`) and be **surfaced everywhere a prompt or response appears in the UI**, but **truncated to the first 200 characters** with an ellipsis (`…`) when overflowing. Full text is never sent to the browser — truncation happens in the SQL query (`SUBSTR(prompt_text, 1, 200) || CASE WHEN length(prompt_text) > 200 THEN '…' ELSE '' END`). Keep the full text in the warehouse for future use (search, deep-drill, replay) but do not transmit it.

**UI rule:** every place that today shows `session_title`, `agent`, or just a session_id snippet should *additionally* show the first 200 chars of the first user prompt of that session/span. Specifically:
- Sessions ledger: add a "Prompt" column (200-char truncation of `fact_prompts.prompt_text` for `turn_number=1`)
- Session detail prompts walk: show 200 chars of `prompt_text` AND 200 chars of `assistant_response` summary
- App profile side panel: 200 chars of the top prompts in that app
- Agent profile side panel: 200 chars of prompts directed at that agent
- Dashboard "Editor's note": pick the loudest prompt (max output_tokens) of the day, 200 chars, attribute to its agent

---

## 12. Implementation appendix — copy-pasteable stubs

Each step below is a self-contained unit. Implementer runs them top-to-bottom. After each step, run the verification query in the same fenced block.

### Step 0 — fix the design tokens (URGENT, do first)

The live site is rendering with indigo accents (`#818cf8`) instead of the design's warm tan (`#d9b787`). This is a 12-line edit in `frontend/public/styles/globals.css` at `:root`. Replace the existing token block (lines 6–17) with:

```css
:root {
  --bg:        #0c0907;
  --bg-2:      #110e0a;
  --ink:       #efe6d6;
  --ink-2:     #d6cdbf;
  --muted:     #8a7d6a;
  --muted-2:   #5f5547;
  --accent:    #d9b787;
  --accent-2:  #e8a87c;
  --rule:        rgba(239, 230, 214, 0.10);
  --rule-strong: rgba(239, 230, 214, 0.28);
  --muted-bar:   rgba(239, 230, 214, 0.05);
  --warn:      #d97c5e;
  /* fonts + --pad stay as-is */
```

Single grep to find any hard-coded indigo or zinc leak: `rg -n "#818cf8|#a5b4fc|#fafafa|#a1a1aa|#71717a|#ef4444|#09090b|#18181b" frontend/` — if any matches remain in CSS files outside `globals.css`, replace them with the corresponding token from the table above.

**Verify:** `curl -s http://localhost:3000 | grep -o "var(--accent)" | head` returns matches (already true), and visually the nav, hero `<em>`, and KPI accent should be tan, not blue.

### Step 1 — `dbt/models/intermediate/int_event_agent.sql` (new)

Goal: resolve `(session_id, event_uuid) → agent` where agent is the Task tool's `subagent_type`, falling back to `'main'`.

```sql
{{ config(materialized='table') }}

-- 1. Find every Task / Agent tool_use and its subagent_type.
WITH task_dispatches AS (
    SELECT
        tc.tenant_id,
        tc.session_id,
        tc.tool_use_id,
        tc.event_uuid     AS dispatching_event_uuid,
        json_extract_string(CAST(tc.input_payload AS VARCHAR), '$.subagent_type') AS subagent_type
    FROM {{ ref('stg_tool_calls') }} tc
    WHERE tc.tool_name IN ('Task','Agent')
      AND json_extract_string(CAST(tc.input_payload AS VARCHAR), '$.subagent_type') IS NOT NULL
),
-- 2. The tool_result event carrying the Task output has parent_uuid =
--    the dispatching assistant event_uuid. Walk DOWN from there: every
--    descendant event in the session whose parent chain passes through
--    that tool_use belongs to the subagent.
--
--    Practical heuristic: in claude-code JSONL, all events with
--    is_sidechain=true that *follow* a Task dispatch and *precede* its
--    matching tool_result belong to that subagent. Use the timestamp
--    window from the dispatching event to the matching tool_result.
sidechain_windows AS (
    SELECT
        td.tenant_id,
        td.session_id,
        td.tool_use_id,
        td.subagent_type,
        td.dispatching_event_uuid,
        tr.ts AS dispatch_ts,
        -- matching tool_result for this tool_use_id
        (SELECT MIN(tr2.ts) FROM {{ ref('stg_tool_results') }} tr2
         WHERE tr2.tool_use_id = td.tool_use_id
           AND tr2.tenant_id  = td.tenant_id)        AS result_ts
    FROM task_dispatches td
    LEFT JOIN {{ ref('stg_events') }} tr
        ON tr.uuid = td.dispatching_event_uuid
        AND tr.tenant_id = td.tenant_id
),
-- 3. Stamp every sidechain event that falls inside a window.
labeled AS (
    SELECT
        e.tenant_id,
        e.uuid                AS event_uuid,
        e.session_id,
        COALESCE(sw.subagent_type, 'main') AS agent_resolved
    FROM {{ ref('stg_events') }} e
    LEFT JOIN sidechain_windows sw
        ON  e.tenant_id  = sw.tenant_id
        AND e.session_id = sw.session_id
        AND e.is_sidechain = TRUE
        AND e.ts >= sw.dispatch_ts
        AND e.ts <= COALESCE(sw.result_ts, e.ts)
)
SELECT * FROM labeled
```

**Verify:**
```sql
SELECT agent_resolved, COUNT(*) FROM int_event_agent GROUP BY 1 ORDER BY 2 DESC;
-- expect at least 'main' present; if you've used /agent, expect subagent names too
```

> **Note for implementer:** if the sample session has zero Task dispatches, this mart will return all `main` — that's correct. Don't fake data.

### Step 2 — `dbt/models/marts/dim_apps.sql` (rewrite) and `dim_projects.sql` (rewrite)

Replace current bodies with cwd-segment parsing. Apps are nested under `apps/`, `services/`, or `packages/`; otherwise app == project.

```sql
-- dim_apps.sql
{{ config(materialized='table') }}

WITH cwds AS (
    SELECT DISTINCT tenant_id, cwd
    FROM {{ ref('stg_events') }}
    WHERE cwd IS NOT NULL
),
parsed AS (
    SELECT
        tenant_id,
        cwd,
        string_split(replace(cwd, '\\', '/'), '/') AS parts
    FROM cwds
),
classify AS (
    SELECT
        tenant_id,
        cwd,
        parts,
        list_position(parts, 'apps')     AS apps_idx,
        list_position(parts, 'services') AS svc_idx,
        list_position(parts, 'packages') AS pkg_idx,
        len(parts)                       AS n
    FROM parsed
),
naming AS (
    SELECT
        tenant_id,
        cwd,
        CASE
            WHEN apps_idx > 0 AND apps_idx < n THEN parts[apps_idx + 1]
            WHEN svc_idx  > 0 AND svc_idx  < n THEN parts[svc_idx  + 1]
            WHEN pkg_idx  > 0 AND pkg_idx  < n THEN parts[pkg_idx  + 1]
            ELSE parts[n]
        END                                                                   AS app_id,
        CASE
            WHEN apps_idx > 0 THEN parts[apps_idx - 1]
            WHEN svc_idx  > 0 THEN parts[svc_idx  - 1]
            WHEN pkg_idx  > 0 THEN parts[pkg_idx  - 1]
            ELSE parts[n]
        END                                                                   AS project_id
    FROM classify
),
stats AS (
    SELECT
        s.tenant_id,
        s.cwd,
        SUM(s.total_cost)               AS total_cost,
        SUM(s.turn_count)               AS total_turns,
        COUNT(DISTINCT s.session_id)    AS session_count,
        COUNT(DISTINCT s.agent)         AS agent_count,
        array_agg(DISTINCT s.agent)     AS agents,
        MIN(s.start_ts)                 AS first_seen,
        MAX(s.end_ts)                   AS last_seen
    FROM {{ ref('dim_sessions') }} s
    GROUP BY s.tenant_id, s.cwd
)
SELECT
    n.tenant_id,
    n.app_id,
    n.app_id              AS app_name,
    n.project_id,
    n.cwd,
    COALESCE(st.total_cost, 0)    AS total_cost,
    COALESCE(st.total_turns, 0)   AS total_turns,
    COALESCE(st.session_count, 0) AS session_count,
    COALESCE(st.agent_count, 0)   AS agent_count,
    st.agents,
    st.first_seen,
    st.last_seen
FROM naming n
LEFT JOIN stats st USING (tenant_id, cwd)
```

```sql
-- dim_projects.sql
{{ config(materialized='table') }}

SELECT
    tenant_id,
    project_id,
    project_id                                AS project_name,
    COUNT(DISTINCT app_id)                    AS app_count,
    SUM(session_count)                        AS session_count,
    SUM(total_turns)                          AS total_turns,
    SUM(total_cost)                           AS total_cost,
    array_distinct(flatten(array_agg(agents))) AS agents,
    MIN(first_seen)                           AS first_seen,
    MAX(last_seen)                            AS last_seen
FROM {{ ref('dim_apps') }}
GROUP BY tenant_id, project_id
```

**Verify:**
```sql
SELECT app_id, project_id, total_cost FROM dim_apps ORDER BY total_cost DESC;
-- expect e.g. ('fitscore', 'crosshire'), ('AURA', 'AURA'), ('learn', 'crosshire')
```

### Step 3 — `dbt/models/marts/dim_sessions.sql` (edit)

Replace `agent_per_session.ANY_VALUE(agent)` with the resolved agent + an agents array, and add app_id/project_id from `dim_apps`. Also expose `session_title` from the first user prompt.

Concrete change at lines 61–73 of current `dim_sessions.sql`:

```sql
-- BEFORE:
agent_per_session AS (
    SELECT session_id, ANY_VALUE(agent) AS agent
    FROM {{ ref('stg_events') }}
    GROUP BY session_id
),

-- AFTER:
agent_per_session AS (
    SELECT
        e.tenant_id,
        e.session_id,
        -- Mode (most common) resolved agent for back-compat
        mode() WITHIN GROUP (ORDER BY ea.agent_resolved) AS agent,
        array_distinct(array_agg(ea.agent_resolved))     AS agents,
        COUNT(DISTINCT ea.agent_resolved)                AS agent_count
    FROM {{ ref('stg_events') }} e
    LEFT JOIN {{ ref('int_event_agent') }} ea
        ON ea.tenant_id = e.tenant_id AND ea.event_uuid = e.uuid
    GROUP BY e.tenant_id, e.session_id
),
first_prompt AS (
    SELECT
        tenant_id,
        session_id,
        FIRST(SUBSTR(user_prompt, 1, 200) ORDER BY user_ts) AS first_prompt_200,
        FIRST(user_ts                       ORDER BY user_ts) AS first_user_ts
    FROM {{ ref('int_turns') }}
    WHERE user_prompt IS NOT NULL
    GROUP BY tenant_id, session_id
),
app_lookup AS (
    SELECT tenant_id, cwd, app_id, project_id
    FROM {{ ref('dim_apps') }}
)
```

…then add `LEFT JOIN first_prompt fp …` and `LEFT JOIN app_lookup al …` to the final SELECT, and expose:
- `al.app_id, al.project_id`
- `ag.agents` (array column), `ag.agent_count`
- `COALESCE(sm.session_title, fp.first_prompt_200, s.session_id)` as `session_title` (so the UI never shows naked session IDs)

**Verify:**
```sql
SELECT session_id, agent, agents, app_id, project_id, LEFT(session_title, 60) FROM dim_sessions LIMIT 10;
```

### Step 4 — `dbt/models/marts/fact_prompts.sql` (new)

```sql
{{ config(materialized='table') }}

WITH external_user_events AS (
    -- Only external user prompts; skip tool_result user events and meta
    SELECT
        e.tenant_id,
        e.session_id,
        e.uuid             AS prompt_id,
        e.ts               AS prompt_ts,
        e.parent_uuid,
        e.payload,
        json_extract_string(e.payload, '$.userType')          AS user_type,
        json_extract_string(e.payload, '$.isMeta')            AS is_meta,
        -- Only string content is a real prompt; array content == tool_result
        CASE
            WHEN substr(trim(json_extract_string(e.payload, '$.message.content')), 1, 1) = '['
            THEN NULL
            ELSE json_extract_string(e.payload, '$.message.content')
        END                                                   AS prompt_text
    FROM {{ ref('stg_events') }} e
    WHERE e.event_type = 'user'
      AND json_extract_string(e.payload, '$.userType') = 'external'
      AND COALESCE(json_extract_string(e.payload, '$.isMeta'), 'false') != 'true'
),
real_prompts AS (
    SELECT * FROM external_user_events WHERE prompt_text IS NOT NULL
),
windowed AS (
    SELECT
        rp.*,
        LEAD(prompt_ts) OVER (
            PARTITION BY tenant_id, session_id ORDER BY prompt_ts
        )                                                     AS next_prompt_ts,
        ROW_NUMBER() OVER (
            PARTITION BY tenant_id, session_id ORDER BY prompt_ts
        )                                                     AS prompt_idx
    FROM real_prompts rp
),
-- Aggregate everything that happened between prompt_ts and next_prompt_ts
spans AS (
    SELECT
        w.tenant_id, w.session_id, w.prompt_id, w.prompt_ts, w.next_prompt_ts, w.prompt_idx,
        SUBSTR(w.prompt_text, 1, 200)
            || CASE WHEN length(w.prompt_text) > 200 THEN '…' ELSE '' END   AS prompt_text_200,
        w.prompt_text                                                       AS prompt_text_full,
        length(w.prompt_text)                                               AS prompt_chars,
        -- first assistant turn in span anchors model
        (SELECT model FROM {{ ref('fact_turns') }} ft
         WHERE ft.session_id = w.session_id AND ft.tenant_id = w.tenant_id
           AND ft.assistant_ts >= w.prompt_ts
           AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
         ORDER BY ft.assistant_ts LIMIT 1)                                  AS model_primary,
        -- summary = first 200 chars of LAST assistant response in span
        (SELECT SUBSTR(assistant_response, 1, 200)
                || CASE WHEN length(assistant_response) > 200 THEN '…' ELSE '' END
         FROM {{ ref('fact_turns') }} ft
         WHERE ft.session_id = w.session_id AND ft.tenant_id = w.tenant_id
           AND ft.assistant_ts >= w.prompt_ts
           AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
           AND ft.assistant_response IS NOT NULL
         ORDER BY ft.assistant_ts DESC LIMIT 1)                             AS summary_200,
        -- aggregates
        (SELECT COUNT(*) FROM {{ ref('fact_turns') }} ft
         WHERE ft.session_id = w.session_id AND ft.assistant_ts >= w.prompt_ts
           AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts))  AS turn_count,
        (SELECT COALESCE(SUM(tool_count), 0) FROM {{ ref('fact_turns') }} ft
         WHERE ft.session_id = w.session_id AND ft.assistant_ts >= w.prompt_ts
           AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts))  AS tool_call_count,
        (SELECT COALESCE(SUM(output_tokens), 0) FROM {{ ref('fact_turns') }} ft
         WHERE ft.session_id = w.session_id AND ft.assistant_ts >= w.prompt_ts
           AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts))  AS output_tokens_total,
        (SELECT COALESCE(SUM(calculated_cost), 0) FROM {{ ref('fact_turns') }} ft
         WHERE ft.session_id = w.session_id AND ft.assistant_ts >= w.prompt_ts
           AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts))  AS cost_total,
        (SELECT COUNT(DISTINCT json_extract_string(CAST(input_payload AS VARCHAR), '$.file_path'))
         FROM {{ ref('fact_tool_executions') }} fte
         WHERE fte.session_id = w.session_id
           AND fte.tool_call_ts >= w.prompt_ts
           AND (w.next_prompt_ts IS NULL OR fte.tool_call_ts < w.next_prompt_ts)
           AND fte.tool_name IN ('Edit','Write')
           AND json_extract_string(CAST(input_payload AS VARCHAR), '$.file_path') IS NOT NULL) AS files_edited,
        (SELECT COUNT(*) FROM {{ ref('fact_tool_executions') }} fte
         WHERE fte.session_id = w.session_id
           AND fte.tool_call_ts >= w.prompt_ts
           AND (w.next_prompt_ts IS NULL OR fte.tool_call_ts < w.next_prompt_ts)
           AND fte.is_error = TRUE)                                                AS errors_caught
    FROM windowed w
),
with_agent_and_app AS (
    SELECT
        s.*,
        -- resolved agent on the FIRST assistant turn in span
        (SELECT ea.agent_resolved FROM {{ ref('int_event_agent') }} ea
         JOIN {{ ref('fact_turns') }} ft USING (tenant_id)
         WHERE ea.event_uuid = ft.assistant_event_uuid
           AND ft.session_id = s.session_id
           AND ft.assistant_ts >= s.prompt_ts
           AND (s.next_prompt_ts IS NULL OR ft.assistant_ts < s.next_prompt_ts)
         ORDER BY ft.assistant_ts LIMIT 1)                                          AS agent,
        da.app_id,
        da.project_id,
        EXTRACT(EPOCH FROM (COALESCE(s.next_prompt_ts, NOW()) - s.prompt_ts))       AS duration_seconds
    FROM spans s
    LEFT JOIN {{ ref('dim_sessions') }} ds USING (tenant_id, session_id)
    LEFT JOIN {{ ref('dim_apps') }} da     ON da.cwd = ds.cwd AND da.tenant_id = s.tenant_id
),
-- Overkill heuristic
scored AS (
    SELECT
        *,
        -- complexity tier from MAX of three signals
        GREATEST(
            CASE WHEN COALESCE(prompt_chars, 0) < 400 THEN 0
                 WHEN prompt_chars < 1600 THEN 1
                 WHEN prompt_chars < 6000 THEN 2 ELSE 3 END,
            CASE WHEN tool_call_count = 0 THEN 0
                 WHEN tool_call_count < 5 THEN 1
                 WHEN tool_call_count < 20 THEN 2 ELSE 3 END,
            CASE WHEN files_edited = 0 THEN 0
                 WHEN files_edited < 3 THEN 1
                 WHEN files_edited < 8 THEN 2 ELSE 3 END
        )                                                            AS complexity_tier,
        -- actual model tier
        CASE
            WHEN model_primary LIKE '%haiku%'           THEN 0
            WHEN model_primary LIKE '%gemini-2.5-flash%' THEN 1
            WHEN model_primary LIKE '%sonnet%'           THEN 1
            WHEN model_primary LIKE '%gemini-2.5-pro%'   THEN 2
            WHEN model_primary LIKE '%opus%'             THEN 3
            ELSE 1
        END                                                          AS actual_model_tier
    FROM with_agent_and_app
)
SELECT
    tenant_id,
    session_id,
    prompt_id,
    prompt_idx,
    prompt_ts,
    next_prompt_ts,
    duration_seconds,
    prompt_text_200,
    prompt_text_full,
    prompt_chars,
    summary_200,
    COALESCE(agent, 'main') AS agent,
    app_id,
    project_id,
    model_primary,
    turn_count,
    tool_call_count,
    files_edited,
    output_tokens_total,
    cost_total,
    errors_caught,
    complexity_tier,
    actual_model_tier,
    CASE complexity_tier
        WHEN 0 THEN 0   -- expect haiku
        WHEN 1 THEN 1   -- expect sonnet/flash
        WHEN 2 THEN 2   -- expect sonnet/gpro
        ELSE 3
    END                                                              AS expected_model_tier,
    (actual_model_tier > CASE complexity_tier WHEN 0 THEN 0 WHEN 1 THEN 1 WHEN 2 THEN 2 ELSE 3 END)
                                                                     AS is_overkill,
    CASE
        WHEN actual_model_tier > CASE complexity_tier WHEN 0 THEN 0 WHEN 1 THEN 1 WHEN 2 THEN 2 ELSE 3 END
        THEN model_primary || ' on T' || complexity_tier
             || ' task: ' || prompt_chars::VARCHAR || ' chars, '
             || tool_call_count::VARCHAR || ' tools, '
             || files_edited::VARCHAR || ' files'
        ELSE NULL
    END                                                              AS overkill_reason
FROM scored
```

**Verify:**
```sql
SELECT
    COUNT(*) AS prompts,
    SUM(is_overkill::int) AS overkill_count,
    AVG(cost_total) AS avg_cost,
    AVG(turn_count) AS avg_turns
FROM fact_prompts;
-- expect prompts >= 1 (unless the DB is empty), and avg_turns >= 1
```

### Step 5 — `dbt/models/marts/fact_session_files.sql` (rewrite)

Add proportional attribution columns. Keep `edit_count` and `write_count`.

```sql
{{ config(materialized='table') }}

WITH file_touches AS (
    SELECT
        fte.tenant_id,
        fte.session_id,
        fte.assistant_event_uuid,
        json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path') AS file_path,
        regexp_extract(
            json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path'),
            '\.([^.]+)$', 1
        )                                                                      AS file_ext,
        fte.tool_name,
        fte.execution_duration_seconds
    FROM {{ ref('fact_tool_executions') }} fte
    WHERE fte.tool_name IN ('Edit','Write','Read')
      AND json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path') IS NOT NULL
),
turn_files AS (
    -- For each assistant turn, count distinct files touched (k)
    SELECT
        tenant_id,
        session_id,
        assistant_event_uuid,
        COUNT(DISTINCT file_path) AS k
    FROM file_touches
    GROUP BY tenant_id, session_id, assistant_event_uuid
),
turn_metrics AS (
    SELECT
        ft.tenant_id,
        ft.session_id,
        ft.assistant_event_uuid,
        ft.output_tokens,
        ft.calculated_cost
    FROM {{ ref('fact_turns') }} ft
),
joined AS (
    SELECT
        ft.tenant_id,
        ft.session_id,
        ft.file_path,
        ft.file_ext,
        ft.tool_name,
        ft.execution_duration_seconds,
        tm.output_tokens,
        tm.calculated_cost,
        tf.k
    FROM file_touches ft
    LEFT JOIN turn_files   tf USING (tenant_id, session_id, assistant_event_uuid)
    LEFT JOIN turn_metrics tm USING (tenant_id, session_id, assistant_event_uuid)
)
SELECT
    session_id,
    file_path,
    file_ext,
    COUNT(*)                                                    AS edit_count,
    SUM(CASE WHEN tool_name IN ('Edit','Write') THEN 1 ELSE 0 END) AS write_count,
    SUM(execution_duration_seconds)                             AS duration_attributed_seconds,
    SUM(COALESCE(output_tokens, 0) / NULLIF(k, 0))              AS tokens_attributed,
    SUM(COALESCE(calculated_cost, 0) / NULLIF(k, 0))            AS cost_attributed
FROM joined
GROUP BY session_id, file_path, file_ext
```

**Verify:**
```sql
SELECT file_path, edit_count, ROUND(tokens_attributed) AS tok, ROUND(cost_attributed, 4) AS cost
FROM fact_session_files ORDER BY tokens_attributed DESC LIMIT 10;
```

### Step 6 — `dbt/models/marts/dim_agents.sql` (new)

```sql
{{ config(materialized='table') }}

WITH base AS (
    SELECT
        ds.tenant_id,
        COALESCE(ds.agent, 'main') AS agent,
        da.app_id,
        da.project_id,
        ds.session_id,
        ds.turn_count,
        ds.total_cost,
        ds.tools_used,
        ds.files_touched,
        ds.total_output_tokens,
        ds.total_input_tokens,
        ds.start_ts, ds.end_ts
    FROM {{ ref('dim_sessions') }} ds
    LEFT JOIN {{ ref('dim_apps') }} da
        ON da.cwd = ds.cwd AND da.tenant_id = ds.tenant_id
)
SELECT
    tenant_id,
    agent,
    app_id,
    project_id,
    COUNT(DISTINCT session_id)        AS session_count,
    SUM(turn_count)                   AS total_turns,
    SUM(tools_used)                   AS total_tool_calls,
    SUM(total_cost)                   AS total_cost,
    SUM(total_output_tokens)          AS total_output_tokens,
    SUM(total_input_tokens)           AS total_input_tokens,
    SUM(files_touched)                AS total_files,
    MIN(start_ts)                     AS first_seen,
    MAX(COALESCE(end_ts, start_ts))   AS last_seen
FROM base
GROUP BY tenant_id, agent, app_id, project_id
```

**Verify:**
```sql
SELECT agent, app_id, project_id, session_count, ROUND(total_cost, 2) AS cost FROM dim_agents ORDER BY total_cost DESC LIMIT 10;
```

### Step 7 — Frontend queries (`frontend/lib/queries/`)

Create / extend the files below. All queries follow the existing pattern (`query()` and `queryOne()` helpers from `lib/db`).

**7a. `prompts.ts` (new):**
```ts
import { query } from '../db'

export async function getSessionPrompts(sessionId: string) {
  return query(`
    SELECT prompt_idx, prompt_ts, duration_seconds,
           prompt_text_200, summary_200,
           agent, model_primary, turn_count, tool_call_count,
           files_edited, output_tokens_total, cost_total, errors_caught,
           is_overkill, overkill_reason, complexity_tier
    FROM fact_prompts
    WHERE session_id = ?
    ORDER BY prompt_ts
  `, [sessionId])
}

export async function getAppPrompts(appId: string, limit = 6) {
  return query(`
    SELECT prompt_idx, prompt_ts, prompt_text_200, agent, cost_total,
           turn_count, tool_call_count, files_edited, session_id
    FROM fact_prompts
    WHERE app_id = ?
    ORDER BY cost_total DESC
    LIMIT ?
  `, [appId, limit])
}

export async function getAgentPrompts(agent: string, limit = 6) {
  return query(`
    SELECT prompt_idx, prompt_ts, prompt_text_200, app_id, cost_total,
           turn_count, files_edited, session_id, is_overkill
    FROM fact_prompts
    WHERE agent = ?
    ORDER BY prompt_ts DESC
    LIMIT ?
  `, [agent, limit])
}

export async function getOverkillPrompts(limit = 5) {
  return query(`
    SELECT prompt_text_200, agent, app_id, model_primary, overkill_reason,
           cost_total, session_id, prompt_ts
    FROM fact_prompts
    WHERE is_overkill = TRUE
    ORDER BY cost_total DESC
    LIMIT ?
  `, [limit])
}

export async function getLoudestPromptOfDay() {
  return query(`
    SELECT prompt_text_200, agent, app_id, model_primary, output_tokens_total
    FROM fact_prompts
    WHERE prompt_ts >= CURRENT_DATE - INTERVAL '1 day'
    ORDER BY output_tokens_total DESC
    LIMIT 1
  `).then(rs => rs[0] ?? null)
}
```

**7b. `agents.ts` (new):**
```ts
import { query, queryOne } from '../db'

export async function getAgent(name: string) {
  return queryOne(`
    SELECT agent,
           COUNT(DISTINCT app_id)         AS app_count,
           SUM(session_count)             AS session_count,
           SUM(total_turns)               AS total_turns,
           SUM(total_tool_calls)          AS total_tool_calls,
           SUM(total_cost)                AS total_cost,
           SUM(total_output_tokens)       AS total_output_tokens,
           array_distinct(array_agg(app_id))      AS apps,
           array_distinct(array_agg(project_id))  AS projects,
           MIN(first_seen)                AS first_seen,
           MAX(last_seen)                 AS last_seen
    FROM dim_agents
    WHERE agent = ?
    GROUP BY agent
  `, [name])
}

export async function getAgentApps(name: string) {
  return query(`
    SELECT app_id, project_id, session_count, total_turns,
           total_cost, total_tool_calls
    FROM dim_agents WHERE agent = ?
    ORDER BY total_cost DESC
  `, [name])
}

export async function getAgentModels(name: string) {
  return query(`
    SELECT ft.model, SUM(ft.calculated_cost) AS cost,
           COUNT(DISTINCT ft.session_id) AS sessions
    FROM fact_turns ft
    LEFT JOIN int_event_agent ea
      ON ea.event_uuid = ft.assistant_event_uuid AND ea.tenant_id = ft.tenant_id
    WHERE COALESCE(ea.agent_resolved, 'main') = ?
    GROUP BY ft.model
    ORDER BY cost DESC
  `, [name])
}

export async function getAgentSessions(name: string, limit = 12) {
  return query(`
    SELECT ds.session_id, ds.start_ts, ds.end_ts, ds.model, ds.turn_count,
           ds.total_cost, ds.session_title, ds.cwd, da.app_id
    FROM dim_sessions ds
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd
    WHERE ds.agent = ?
    ORDER BY ds.start_ts DESC
    LIMIT ?
  `, [name, limit])
}

export async function getAgentFiles(name: string, limit = 8) {
  return query(`
    SELECT fsf.file_path, fsf.file_ext,
           SUM(fsf.tokens_attributed)            AS tokens,
           SUM(fsf.duration_attributed_seconds)  AS duration_s,
           SUM(fsf.edit_count)                   AS edits
    FROM fact_session_files fsf
    JOIN dim_sessions ds ON ds.session_id = fsf.session_id
    WHERE ds.agent = ?
    GROUP BY fsf.file_path, fsf.file_ext
    ORDER BY tokens DESC
    LIMIT ?
  `, [name, limit])
}
```

**7c. `apps.ts` (extend):** add
```ts
export async function getApp(appId: string) {
  return queryOne(`
    SELECT da.*, dp.project_name
    FROM dim_apps da
    LEFT JOIN dim_projects dp USING (project_id, tenant_id)
    WHERE da.app_id = ?
  `, [appId])
}

export async function getAppAgents(appId: string) {
  return query(`
    SELECT agent, session_count, total_turns, total_cost, total_tool_calls
    FROM dim_agents WHERE app_id = ?
    ORDER BY total_cost DESC
  `, [appId])
}

export async function getAppSessions(appId: string, limit = 12) {
  return query(`
    SELECT ds.session_id, ds.start_ts, ds.end_ts, ds.model, ds.agent,
           ds.turn_count, ds.total_cost, ds.session_title
    FROM dim_sessions ds
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd
    WHERE da.app_id = ?
    ORDER BY ds.start_ts DESC
    LIMIT ?
  `, [appId, limit])
}
```

**7d. `files.ts` (new):**
```ts
import { query } from '../db'

export async function getSessionFilesWithAttribution(sessionId: string) {
  return query(`
    SELECT file_path, file_ext, edit_count, write_count,
           tokens_attributed, duration_attributed_seconds, cost_attributed
    FROM fact_session_files
    WHERE session_id = ?
    ORDER BY tokens_attributed DESC NULLS LAST
  `, [sessionId])
}

export async function getTopFilesByCost(limit = 10) {
  return query(`
    SELECT file_path, file_ext,
           SUM(edit_count)                  AS edits,
           SUM(tokens_attributed)           AS tokens,
           SUM(cost_attributed)             AS cost,
           SUM(duration_attributed_seconds) AS duration_s,
           COUNT(DISTINCT session_id)       AS sessions
    FROM fact_session_files
    GROUP BY file_path, file_ext
    ORDER BY cost DESC NULLS LAST
    LIMIT ?
  `, [limit])
}
```

**7e. `sessions.ts` (extend `getSessions`):** add to the SELECT list — `app_id` (from `dim_apps`), `agents` (array), `session_title` (now backed by first_prompt_200 fallback). Add a `prompt_preview` column = `first_prompt_200` from `dim_sessions` (also extend dim_sessions to expose it).

### Step 8 — Frontend pages

For each page, the implementer should match the design screenshot exactly. Key code edits:

**8a. `frontend/app/page.tsx` (Dashboard):**
- swap the 6th KPI from "Total spend" to "Projected · 30d" with `(total_cost/14*30)` and a `dailyAvg` footnote.
- flatten "Projects — by cost" → "Apps — by cost" using `getTopApps()` (use `dim_apps`, not the nested projects view). One row per app.
- Editor's note: replace the static placeholder with `getLoudestPromptOfDay()` rendered as 200-char italicised pull-quote + attrib line `— {agent} · {app_id}`.

**8b. `frontend/app/apps/page.tsx`:** rebuild card grid using `getApps()` returning `dim_apps`. Each card shows: glyph, name, project_id underline, 14-day spend (`total_cost`), sessions/turns/agents/errors row, agents-in-rotation chips (max 5).

**8c. `frontend/app/apps/[appId]/page.tsx`:** full screenshot 03 implementation. Header + 6-stat strip + "Agents in this app" table (`getAppAgents`) + "Sessions — recent" (`getAppSessions`) + side panel "Recent prompts in this app" (`getAppPrompts`).

**8d. `frontend/app/agents/[name]/page.tsx`:** **new build** matching screenshot 06. Header (hex glyph, "serving N people in M apps", 14-day spend, sparkline), 6-stat strip, "Apps served" table (`getAgentApps`), "Models routed to" (`getAgentModels`), "Sessions — recent" (`getAgentSessions`), side panel: "What {agent} touches" — top files (`getAgentFiles`) + "Prompts directed at {agent}" (`getAgentPrompts`, 200 char each).

**8e. `frontend/app/sessions/page.tsx`:** add the 5-stat strip above the table. Add `prompt_preview` column (the 200-char first prompt). Use `dim_sessions.app_id` not naive `cwd.split('/').pop()`.

**8f. `frontend/app/sessions/[sessionId]/page.tsx` (or `components/SessionTabs.tsx`):**
- Per-turn stacked-token chart (wire `fact_turns` → reuse the design's `TurnChart` SVG component from `session.jsx`).
- Side rail "Files · this session": columns are now `path | tokens | duration | edits` from `getSessionFilesWithAttribution`.
- **New full-width block: "Prompts & responses"** below the cols, rendered from `getSessionPrompts`. Each row:
  - `#NN` + time + duration + agent + model pill + (overkill chip if `is_overkill`)
  - `prompt_text_200` in italics
  - response meta line: `turn_count · tool_call_count · files_edited · output_tokens · cost · errors_caught`
  - `summary_200` paragraph
  - tools chips (decoded from `tools_used_json` if needed; or skip if not modeled this round)

**8g. `frontend/app/errors/page.tsx`:** match screenshot 09. 5-stat strip (total / hard / warn / sessions_affected / top tools). Severity-kind chip row across the top, table below.

### Step 9 — Operational reset (MANDATORY — do not skip)

After all dbt changes you **must** rerun the entire model graph with `--full-refresh` because several existing marts (`dim_sessions`, `dim_apps`, `fact_session_files`) have new/renamed columns. Incremental runs will fail or silently drop columns.

```bash
# inside the watcher container:
docker compose exec watcher bash -lc "cd /app/dbt && dbt build --profiles-dir . --full-refresh"

# OR locally if dbt is installed on the host:
cd D:\darshanmeel\AURA\dbt && dbt build --profiles-dir . --full-refresh
```

If the dbt worker thread in `watcher/src/aura_watcher/main.py` is the only path that can reach the DB, restart the watcher container — on next worker tick it'll re-build. Don't manually delete the duckdb file unless build errors persist.

Restart the frontend dev server is **not** required — Next.js will pick up source changes on save; only a `docker compose restart frontend` if the runtime DB connection got cached.

### Step 10 — End-to-end verification (must all pass before declaring done)

1. `curl -s http://localhost:3000/ | grep -o '\$[0-9]\+' | head -3` returns at least one non-zero dollar value (hero spend rendered).
2. `curl -s http://localhost:3000/apps | grep -c 'card-glyph'` returns >= 1 (apps grid rendered).
3. Visit `/agents/main` in browser — page exists, doesn't 404, shows numbers.
4. Visit `/sessions/<known_session_id>` — Prompts & responses block visible, at least one prompt's text shown (truncated to 200 chars max — verify by inspecting the HTML).
5. `SELECT COUNT(*) FROM fact_prompts WHERE is_overkill` returns a sensible number (could be 0 if all your usage is appropriately sized — that's also a valid signal).
6. Any place that displays a prompt text in HTML: `LENGTH(textContent)` of the corresponding cell <= 201 (200 chars + ellipsis).

---

*End of spec — ready for implementation handoff to runner/sonnet.*
