# AURA Dashboard — Next.js Implementation Spec

**Date:** 2026-05-23  
**Design source:** `C:\Users\Acer1\Downloads\AURA Design (1).zip`  
**Status:** Approved for implementation

---

## 1. What We're Building

A Next.js 14 (App Router) dashboard that implements the full AURA editorial design — "Spend, *with receipts*" — backed by real DuckDB data. The design ships as complete JSX (9 pages, ~3,000 lines, full CSS). Our job is to:

1. Port the JSX components to Next.js React components
2. Replace `window.AURA_DATA` with API routes that query DuckDB
3. Add 4 new dbt models to produce the shapes the design expects
4. Extend the watcher to write `person_id` and `commits` so those columns are real the moment git/identity enrichment lands

The design CSS and component atoms (`Eyebrow`, `Sparkline`, `ModelPill`, `AgentLink`, etc.) port verbatim. The editorial aesthetic — warm near-black `#0c0907`, cream ink, tan accent `#d9b787`, Source Serif + JetBrains Mono — is preserved exactly.

---

## 2. Feasibility Verdict

### ✅ Fully buildable now

Dashboard KPIs, daily spend chart, cache 5m/1h split, provider split, model breakdown, tool mix, sessions ledger (filter/sort/search), session detail (per-turn chart, turn table, token breakdown, tool mix, errors), agent profiles, apps profiles, errors log.

### ⚠️ Buildable with approximation

| Feature | Approximation |
|---|---|
| Session title | First `user_prompt` truncated to 80 chars |
| Session status (active/completed) | `end_ts IS NULL` → active |
| Files touched | Parse `input_payload` JSON from Edit/Write/Read tool calls in `fact_tool_executions` |
| Prompt response stats | Walk `fact_turns` between consecutive user messages |
| App identity | `cwd` path — last component = app name, full path = app ID |
| Repo name | Last component of `cwd` (same as app name for now) |

### ❌ Dropped from design (permanently)

| Design feature | Reason |
|---|---|
| App owner, app description | Fictional in design — no metadata in JSONL |
| Prompt response "summary" text | Would require stored assistant summaries — out of scope |

### 🟡 Built as placeholder, lights up later

| Feature | Now | Later |
|---|---|---|
| `person_id` | `whoami` / OS username from watcher | Git email or central identity when multi-machine |
| People page | Shows single person ("you") | Works for multiple people when identity is real |

### ✅ Commits — real now, no placeholder needed

Commits are mined from `fact_tool_executions` (Bash calls containing `git commit`). This is real data, already in the DB. The session detail page also shows a full git command log (commit, push, checkout, merge, etc.) — the actual receipts.

---

## 3. Navigation

Design nav: Dashboard · Apps · People · Sessions · Errors  
Our nav: **Dashboard · Apps · People · Sessions · Errors** (keep People — built for one person now, multi-user later)

Page routing (Next.js App Router):
```
/                          → Dashboard
/apps                      → Apps list
/apps/[appId]              → App profile
/people                    → People list  
/people/[personId]         → Person profile
/agents/[agentName]        → Agent profile (no list page — always entered via link)
/sessions                  → Sessions ledger
/sessions/[sessionId]      → Session detail
/errors                    → Errors log
```

---

## 4. Data Model Changes

### 4.1 Watcher: new `session_meta` table

The watcher writes one row per session when it first sees the session JSONL file:

```sql
CREATE TABLE session_meta (
    session_id      TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL DEFAULT 'local',
    person_id       TEXT,          -- whoami now; git email later
    person_name     TEXT,          -- from ~/.aura/people.json lookup
    commits         INTEGER DEFAULT 0,  -- 0 now; git log count later
    session_title   TEXT,          -- first user prompt, truncated 80 chars
    ingested_at     TIMESTAMP DEFAULT now()
);
```

The watcher populates `person_id` via `getpass.getuser()` (Python) at session creation time. `person_name` is looked up from `~/.aura/people.json` if it exists:

```json
{
  "darshan": { "name": "Darshan Meel", "role": "Founder · solo eng", "avatar": "DM" }
}
```

If the file doesn't exist, `person_name` falls back to `person_id`. `session_title` is extracted from the first user-role message in the JSONL.

### 4.2 New dbt models (5)

#### `dim_apps` (new)
```sql
-- Group sessions by cwd to derive "apps"
SELECT
    tenant_id,
    cwd as app_id,
    regexp_extract(cwd, '[^/\\]+$') as app_name,  -- last path component
    COUNT(DISTINCT session_id)  as session_count,
    COUNT(DISTINCT agent)       as agent_count,
    array_agg(DISTINCT agent)   as agents,
    SUM(total_cost)             as total_cost,
    SUM(turn_count)             as total_turns,
    MIN(start_ts)               as first_seen,
    MAX(end_ts)                 as last_seen
FROM dim_sessions
GROUP BY tenant_id, cwd
```

#### `fact_errors` (new)
Union of two error sources with a unified schema:

```sql
-- Source 1: tool execution failures
SELECT session_id, tool_call_ts as ts, 'tool_error' as kind,
       tool_name as tool, left(output_text, 200) as message,
       'warn' as severity, NULL as turn_number
FROM fact_tool_executions WHERE is_error = true

UNION ALL

-- Source 2: stop_reason errors from assistant events  
SELECT session_id, ts, stop_reason as kind,
       NULL as tool, NULL as message,
       CASE stop_reason WHEN 'max_tokens' THEN 'warn' ELSE 'info' END as severity,
       NULL as turn_number
FROM stg_events
WHERE event_type = 'assistant'
  AND stop_reason IN ('max_tokens', 'refusal')
```

#### `fact_session_files` (new)
Extract file paths from Edit/Write/Read tool call payloads:

```sql
SELECT
    session_id,
    json_extract_string(input_payload, '$.file_path') as file_path,
    regexp_extract(json_extract_string(input_payload, '$.file_path'), '\.([^.]+)$', 1) as file_ext,
    COUNT(*) as edit_count,
    SUM(CASE WHEN tool_name IN ('Edit', 'Write') THEN 1 ELSE 0 END) as write_count
FROM fact_tool_executions
WHERE tool_name IN ('Edit', 'Write', 'Read')
  AND json_extract_string(input_payload, '$.file_path') IS NOT NULL
GROUP BY session_id, file_path
```

#### `fact_git_commands` (new) — **the real commits source**

The agent runs `git commit`, `git push`, `git checkout`, etc. as `Bash` tool calls. These are already stored in `fact_tool_executions.input_payload` (command) and `output_text` (result). We parse them instead of running `git log` separately.

```sql
SELECT
    session_id,
    tool_call_ts as ts,
    json_extract_string(input_payload, '$.command') as raw_command,
    output_text,
    is_error,
    CASE
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git commit%' THEN 'commit'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git push%'   THEN 'push'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git pull%'   THEN 'pull'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git merge%'  THEN 'merge'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git checkout%' THEN 'checkout'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git branch%' THEN 'branch'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git log%'    THEN 'log'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git diff%'   THEN 'diff'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git add%'    THEN 'add'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git status%' THEN 'status'
        ELSE 'other'
    END as git_op
FROM fact_tool_executions
WHERE tool_name = 'Bash'
  AND json_extract_string(input_payload, '$.command') LIKE '%git %'
```

This gives us per-session, per-op counts:
- **commits**: `COUNT(*) WHERE git_op='commit' AND NOT is_error` — real commits the agent made
- **pushes**: `COUNT(*) WHERE git_op='push'`
- **failed git ops**: `COUNT(*) WHERE is_error=true` — e.g. merge conflicts, push failures

`dim_sessions` joins `fact_git_commands` to get `commits_count` and `pushes_count`.

For the Session detail page, the git command log is a new section: a ledger of every git command the agent ran (command, ts, output, success/fail). This is the "receipts" for the commits stat.

#### Enhanced `dim_sessions` (modify existing)
Extend to include:
- `person_id`, `person_name`, `commits` — from `session_meta` (LEFT JOIN)
- `session_title` — from `session_meta`
- `tools_used` — COUNT from `fact_tool_executions`
- `end_turns` — COUNT from `stg_events WHERE stop_reason='end_turn'`
- `files_touched` — COUNT DISTINCT from `fact_session_files`
- `ephemeral_5m_total`, `ephemeral_1h_total` — SUM from `fact_turns`
- `cache_read_total` — SUM from `fact_turns`
- `status` — `CASE WHEN end_ts IS NULL THEN 'active' ELSE 'completed' END`
- `provider` — `CASE WHEN model LIKE 'claude%' THEN 'Anthropic' WHEN model LIKE 'gemini%' THEN 'Google' END`

#### Enhanced `dim_people` (new dbt model)
Aggregate by person_id from dim_sessions:

```sql
SELECT
    tenant_id,
    person_id,
    ANY_VALUE(person_name)      as person_name,
    COUNT(DISTINCT session_id)  as session_count,
    COUNT(DISTINCT cwd)         as app_count,
    array_agg(DISTINCT agent)   as agents,
    array_agg(DISTINCT cwd)     as apps,
    SUM(total_cost)             as total_cost,
    SUM(turn_count)             as total_turns,
    SUM(commits)                as total_commits
FROM dim_sessions
WHERE person_id IS NOT NULL
GROUP BY tenant_id, person_id
```

---

## 5. API Routes (Next.js)

All routes query DuckDB via the `@duckdb/node-api` package. A shared `lib/db.ts` module holds the DuckDB connection singleton.

```
GET /api/dashboard          → KPIs, daily spend, tool mix, top files, recent errors, providers, models, apps summary, agents summary
GET /api/apps               → dim_apps list, sorted by total_cost DESC
GET /api/apps/[appId]       → app detail + sessions + agents + people + recent prompts
GET /api/people             → dim_people list, sorted by total_cost DESC
GET /api/people/[personId]  → person detail + sessions + agents + apps + recent prompts
GET /api/agents/[name]      → agent aggregate + sessions + people + apps + models + files + prompts
GET /api/sessions           → dim_sessions list, with query params: ?provider=&agent=&status=&sort=&q=
GET /api/sessions/[id]      → full session: dim_sessions + fact_turns (sample 60) + fact_errors + fact_session_files + tool mix + prompts
GET /api/errors             → fact_errors, all sessions, sorted by ts DESC
```

Response shapes mirror `window.AURA_DATA` exactly so the JSX components port with minimal changes.

---

## 6. Next.js Project Structure

```
frontend/
├── app/
│   ├── layout.tsx              ← masthead nav + footer + font imports
│   ├── page.tsx                ← Dashboard
│   ├── apps/
│   │   ├── page.tsx            ← Apps list
│   │   └── [appId]/page.tsx    ← App profile
│   ├── people/
│   │   ├── page.tsx            ← People list
│   │   └── [personId]/page.tsx ← Person profile
│   ├── agents/
│   │   └── [name]/page.tsx     ← Agent profile
│   ├── sessions/
│   │   ├── page.tsx            ← Sessions ledger
│   │   └── [sessionId]/page.tsx← Session detail
│   └── errors/
│       └── page.tsx            ← Errors log
├── components/
│   ├── atoms.tsx               ← Eyebrow, Rule, StatBlock, Sparkline, ModelPill, AgentLink, AppLink, PersonLink, ProviderTag, SeverityTag, BarRow
│   ├── charts.tsx              ← DailyChart (SVG), TurnChart (SVG), LegendSwatch
│   ├── tables.tsx              ← SessionMiniTable, LedgerTable
│   └── panels.tsx              ← PromptsSide, ProfileBackRail
├── lib/
│   ├── db.ts                   ← DuckDB connection singleton
│   ├── queries/
│   │   ├── dashboard.ts
│   │   ├── sessions.ts
│   │   ├── apps.ts
│   │   ├── people.ts
│   │   ├── agents.ts
│   │   └── errors.ts
│   └── fmt.ts                  ← fmt.usd, fmt.n, fmt.k, fmt.pct, fmt.date, fmt.time, fmt.duration (ported from design)
├── app/api/                    ← route handlers (one per entity above)
└── public/
    └── styles/
        └── globals.css         ← Editorial CSS from design (styles.css, verbatim)
```

---

## 7. Design System

Port verbatim from `styles.css`. Key tokens:

```css
--bg:         #0c0907;
--bg-2:       #110e0a;
--ink:        #efe6d6;
--ink-2:      #d6cdbf;
--muted:      #8a7d6a;
--accent:     #d9b787;
--accent-2:   #e8a87c;
--warn:       #d97c5e;
--rule:       rgba(239,230,214,.10);
```

Fonts loaded via `next/font` (Google Fonts): Source Serif 4, Geist, JetBrains Mono.

The Tweaks panel (bottom-right: accent swatch, density toggle, showPrompts toggle) is implemented as a client component with `useState`.

---

## 8. Pages — Detailed Specs

### 8.1 Dashboard (`/`)

**Data:** `GET /api/dashboard`

Sections (in order):
1. **Masthead strap** — "N days · 2 providers · N people · N apps" + pipeline last-ingest timestamp
2. **Hero** — "Spend, *with receipts.*" headline, lede text with top session share, CTA buttons, 14-day spend + sparkline
3. **KPI strip** — Active now, Cache hit %, Tool calls, Commits (show 0 if none), Errors, Projected 30d
4. **Main col:**
   - Apps ledger (sortable by cost, click → app profile)
   - Agents ledger (click → agent profile)
   - Files — most edited (from `fact_session_files` aggregated)
   - Errors — recent 5 (from `fact_errors`)
   - Daily spend chart (bars + turn line overlay, SVG)
5. **Side rail:** Top people (6, click → person profile), Tool mix, Providers, Models, Cache 5m/1h, Editor's quote

Commits column shown in Apps/Agents ledgers — displays 0 until watcher adds git integration.

### 8.2 Apps (`/apps` + `/apps/[appId]`)

**Data:** `GET /api/apps`, `GET /api/apps/[appId]`

**Apps list:** Card grid. Each card: app name (last cwd component), full cwd path as subtitle, 14-day spend, sessions/turns/errors, agent chips. No description, no owner (not available).

**App profile:** Header (app glyph = first letter of cwd last component + full cwd path + 14-day spend) → 6-stat strip → People in this app → Agents in rotation → Sessions recent → Prompts side panel.

### 8.3 People (`/people` + `/people/[personId]`)

**Data:** `GET /api/people`, `GET /api/people/[personId]`

Single-person now. People list shows one card. Person profile shows full stats for that person. Avatar derived from initials of `person_name`. Role shown as OS username if no `~/.aura/people.json`.

When multi-user: new sessions from different OS users appear as separate person cards automatically.

### 8.4 Agent Profile (`/agents/[name]`)

**Data:** `GET /api/agents/[name]`

Header (agent glyph ⌬ + name in mono + 14-day spend + sparkline over active days) → KPI strip → People delegating → Apps served → Models routed to → Sessions recent → Side: top files + prompts directed at agent.

### 8.5 Sessions (`/sessions` + `/sessions/[sessionId]`)

**Data:** `GET /api/sessions`, `GET /api/sessions/[id]`

**Sessions list:** Full-width ledger with search (title, session_id, cwd, branch) + filter dropdowns (provider, agent, status) + sort (cost, turns, tokens, started). Columns: Started, Person (show person_name), App (cwd last component), Agent, Title·Branch, Model, Turns, Commits, Cost.

**Session detail:**
- Back rail + session ID
- Header: provider · person · app · agent · cwd/branch, serif headline from session_title
- Meta grid: session_id, cwd, git_branch·commits (0 if none), model·claude_version, started, duration·status
- KPI strip: Turns, Output tokens, Cache 1h, Cache 5m, Cache hit, $/turn
- Per-turn chart (60 sampled turns, stacked tokens + context % line)
- Turn table (first 20)
- Per-session errors table
- Side rail: token breakdown stack, files touched, tool mix
- Full-width Prompts & responses block

### 8.6 Errors (`/errors`)

**Data:** `GET /api/errors`

Cross-session error log from `fact_errors`. Kind chips at top (All, tool_error, max_tokens, refusal). Columns: When, Severity, Kind, Tool, Message, Session, Turn→. Click row → session detail.

---

## 9. People Config File (future-proof)

`~/.aura/people.json` — optional. If present, watcher enriches `person_name` at session creation time:

```json
{
  "darshan": {
    "name": "Darshan Meel",
    "role": "Founder · solo eng",
    "avatar": "DM"
  }
}
```

When multi-machine support lands: the watcher on each machine reads its own `whoami` and the file. The central DB then has rows for multiple `person_id` values automatically.

---

## 10. Commits — Derived from Agent Tool Calls

Commits are **not** fetched from `git log`. They are derived from `fact_git_commands` — the agent's own Bash tool calls that contained `git commit`. This is more accurate: it counts only the commits the agent actually made, not any human commits that happened to land in the same time window.

**Session commits count:**
```sql
SELECT session_id, COUNT(*) as commits_count
FROM fact_git_commands
WHERE git_op = 'commit' AND is_error = FALSE
GROUP BY session_id
```

**Session detail — Git commands log** (new section on session detail page):
A ledger below the errors section showing every git command the agent ran:

| Time | Command | Op | Output (first 120 chars) | Status |
|---|---|---|---|---|
| 04:31 | `git commit -m "fix: drop band-aid..."` | commit | `[main 3e4bd96] fix: drop...` | ✓ |
| 05:12 | `git push origin main` | push | `To github.com/...` | ✓ |
| 06:44 | `git checkout -b feat/ledger-ui` | checkout | `Switched to new branch...` | ✓ |

This is exactly the "receipts" the design's voice promises. No watcher changes needed — all data is already in `fact_tool_executions`.

---

## 11. Phased Delivery

### Phase 1: dbt models
- Modify `dim_sessions` (add person_id, session_title, tools_used, end_turns, files_touched, ephemeral totals, status, provider)
- New `dim_apps`
- New `dim_people`
- New `fact_errors`
- New `fact_session_files`

### Phase 2: Watcher extension
- Write `session_meta` table on new session detection
- Populate `person_id` via `getpass.getuser()`
- Populate `session_title` from first user prompt (truncate 80 chars)
- Read `~/.aura/people.json` for person_name enrichment

### Phase 3: Next.js project scaffold
- `next.config.js`, `tsconfig.json`, `package.json` (dependencies: next, react, @duckdb/node-api)
- Port `styles.css` → `public/styles/globals.css` + `app/globals.css` import
- Port `lib/fmt.ts` from `data.js fmt` object
- Port shared atoms (`components.jsx` → `components/atoms.tsx`, `components/charts.tsx`)

### Phase 4: API routes
- `lib/db.ts` — DuckDB singleton (`~/.claude/projects/aura.duckdb` path from env)
- One route handler per entity (dashboard, apps, people, agents, sessions, errors)
- Query files in `lib/queries/`

### Phase 5: Pages (client-side components with server data fetch)
- Dashboard (most complex — all sections)
- Sessions ledger (filter state is client-side)
- Session detail (per-turn chart SVG)
- Apps list + App profile
- People list + Person profile
- Agent profile
- Errors log

### Phase 6: Integration
- `docker-compose.yml` update — add Next.js service on port 3000
- `aura.toml` frontend config
- End-to-end smoke test: real DuckDB → API → rendered page

---

## 12. Non-Goals

- Authentication / multi-tenant auth (single local machine)
- Replay-grade turn viewer (full payload scrubbing)
- Sidechain analytics (isSidechain surfaced but not a dedicated view)
- AI-generated session summaries
- Real-time push (poll on page focus instead)
