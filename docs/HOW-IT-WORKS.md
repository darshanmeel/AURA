# How it works

## One-writer invariant

Aura enforces a single-writer rule on the DuckDB write database (`aura.duckdb`):
**only the watcher Python process ever opens `aura.duckdb` for writing.**

DuckDB allows at most one write connection per file. Violating this rule causes
`Conflicting lock` errors and data loss. Every other component — dbt (subprocess),
Next.js (reads the snapshot copy) — honours this constraint.

## Data flow

```
~/.claude/projects/**/*.jsonl
        │
        ▼
  aura_watcher (Python)
    ├── ClaudeAdapter / SdkTraceAdapter  (parse JSONL → events[])
    ├── DuckDBWriter                     (INSERT INTO raw_events)
    ├── dbt seed + run + test            (subprocess, every 5 min)
    └── snapshot_worker                  (cp aura.duckdb → read/aura.duckdb, every 2 s)
                                                │
                                                ▼
                                        Next.js 14 (App Router)
                                          └── reads read/aura.duckdb (snapshot, read-only)
```

## Session quality verdicts (inbox-file pattern)

The verdict feature lets users tag a session as `accepted`, `wrong`, or
`needs_review` from the session detail page. Because only the watcher may write
to DuckDB, Next.js cannot INSERT directly. Instead it uses an **inbox file**:

```
User clicks verdict button
        │
        ▼
POST /api/sessions/<id>/verdict          (Next.js App Router API route)
  └── appendFileSync('/data/verdicts-inbox.jsonl', line + '\n')
                                                │
                                                ▼ (every 5 s, main idle loop)
  process_verdicts_inbox()               (aura_watcher/main.py)
    ├── reads new lines from inbox since last offset
    ├── validates session_id / verdict enum
    └── INSERT INTO session_verdicts … ON CONFLICT DO UPDATE
                                                │
                                                ▼ (next dbt run)
  stg_session_verdicts                   (dbt view)
  dim_sessions ←LEFT JOIN verdict_per_session
```

### Why inbox-file?

- Preserves the one-writer invariant: Next.js never opens `aura.duckdb`.
- Atomic appends: `O_APPEND` writes are atomic for single-line JSON on POSIX;
  no lock needed since Next.js is the only inbox writer.
- Fault-tolerant: if the watcher restarts, it re-reads from `state["offset"] = 0`
  (inbox file not found) or resumes from the saved offset (file still present).
- Simple: no HTTP server, no queue, no extra process.

### Inbox file location

Controlled by `AURA_VERDICTS_INBOX` (default `/data/verdicts-inbox.jsonl`).
Set the same env var in both the watcher container and the Next.js container so
they share the `/data` volume path.

### Inbox line schema

```jsonc
{ "session_id": "<uuid>", "tenant_id": "local", "verdict": "accepted", "note": "optional" }
```

`verdict` must be one of `accepted`, `wrong`, `needs_review`. Lines that fail
validation are skipped and logged to `watcher_errors`; they do not block later
lines.

## dbt and snapshot independence

The snapshot worker and dbt runner are fully independent of one another and of
the backfill. dbt runs on whatever data exists in `raw_events` at that moment;
it does not wait for backfill to finish. The snapshot fires every 2 s; the
dashboard always shows data as of the most recent snapshot.
