# Errors — list view

**URL:** `/errors`  
**Primary range:** 7d  
**Variants:** `?range=today`, `?range=all`

## What this screen shows

Complete audit log of errors caught during tool executions, model calls, and the watcher process itself. Surface severity (error/warn/info), kind (tool_error, parse_error, etc.), source tool, raw message, and the session/turn where it occurred. Filterable by error kind; drillable to session detail.

## Layout & components

**Masthead:** Range filter + event count  
**Hero section:** Summary copy (error count by severity, explanation)  
**5-stat strip:** Total events, hard errors, warnings, sessions affected, tool failures  
**Kind filter chips:** Toggleable category filter; chip counts  
**Error table:** ts, severity, kind, tool, message, session (title + agent link), turn number  
**Empty state:** "No errors matching this filter — a quiet day."

## Data sources

| Component | Query | Table(s) |
|---|---|---|
| Error feed + counts | `getErrors(since)` | `fact_errors` |
| Summary KPIs | `getErrorsSummary(since)` | `fact_errors` |
| Kind chip counts | `getErrorsByKind(since)` | `fact_errors` |

## How to read it

- **fact_errors** is the primary source; built by dbt from `fact_tool_executions` (is_error=TRUE) and `watcher_errors` (internal parse/lock failures).
- **Severity** (error, warn, info) is assigned heuristically in the watcher based on message patterns.
- **Kind** (tool_error, parse_error, checkpoint_conflict, etc.) indicates error category.
- **Tool** shows the source (Read, Bash, WebFetch, etc.); NULL for watcher-internal errors.
- **Session** links are clickable; navigates to `/sessions/{session_id}` with error highlighted.
- **Tool failures** KPI = rows where kind = 'tool_error'; a proxy for tool call failures.

## Edge cases / empty states

- **No errors in range:** Empty table with "No errors matching this filter" message.
- **Watcher errors** (parse/lock/format) may cluster on a different kind than tool_error.
- **Messages are pre-truncated:** SQL-side limit at 200 chars; UI does not slice further.
- **Session title + agent:** Joined from `dim_sessions`; if session not found, displays session_id.

## Related screens

- [Session detail — Errors tab](./session-detail.md)
- [Observability — watcher errors](./observability.md)

## Screenshots

**7-day range:**  
![errors-list.png](./errors-list.png)

**Today:**  
![errors-list-today.png](./errors-list-today.png)

**All-time:**  
![errors-list-all.png](./errors-list-all.png)
