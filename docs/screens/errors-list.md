# Errors — list view

**URL:** `/errors`  
**Primary range:** 7d  
**Variants:** today, all-time

## What this screen shows

The complete error log across all agent sessions. Captures tool failures (Read, Bash, WebFetch), parse errors, timeouts, and severity-tagged events. Agents may recover and continue running; this table is the record of what went wrong and where to search in retros.

## Layout & components

- **Masthead strap**: Range filter + event count
- **Hero section**: Display title "What went wrong." + summary prose (hard errors, warnings, info events)
- **5-stat strip**: Total events, hard errors, warnings, affected sessions, tool failures
- **Kind filter chips**: Tap to filter by error kind (All, tool_error, timeout, etc.)
- **Errors table**: Columns are When, Severity, Kind, Tool, Message, Session, Turn

## Data sources

| Component | Query | Mart |
|---|---|---|
| Errors feed (500 cap) | `getErrors` or `getErrorsFiltered` | `fact_errors` |
| KPI strip | `getErrorsSummary` | `fact_errors` |
| Kind histogram | `getErrorsByKind` | `fact_errors` |

## How to read it

- **Severity**: `error` (hard failure, agent may retry), `warn` (degraded but recovery likely), `info` (audit event)
- **Kind**: `tool_error` (Read/Bash/WebFetch failure), `timeout`, `parse_error`, etc. — filter by kind to group related incidents
- **Tool**: If not null, the tool that failed (e.g. "Bash", "WebFetch", "Read")
- **When**: Date + time. Date is new as of May 28; previously time-only. Format: "May 28 · 09:57:26"
- **Message**: Pre-truncated SQL-side to 200 chars; we do not slice on the frontend
- **Session**: Session title (if available, unparsed) + agent name (defaults to "main") + session ID (8-char truncated) — click row to jump to session detail

## Edge cases / empty states

- No errors in range → displays "No errors matching this filter — a quiet day."
- High-frequency same-kind errors → use Kind filter chips to focus investigation
- Tool=null → watcher/infrastructure error (dbt, snapshot, lock failures are logged separately in observability)

## Related screens

- [Session detail — Errors tab](./session-detail.md)
- [Observability](./observability.md) — watcher/parser errors

## Screenshots

- 7d: ![](./errors-list.png)
- Today: ![](./errors-list-today.png)
- All: ![](./errors-list-all.png)
