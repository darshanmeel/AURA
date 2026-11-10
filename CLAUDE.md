# Aura — project memory

Aura is a local-first analytics tool for AI-coding-agent transcripts (Claude Code today, Gemini/Codex later). It ingests `~/.claude/projects/**/*.jsonl` in real time via a `watchdog` process into a Parquet lake (`data/lake/`, flushed every 30 s), runs dbt every `AURA_DBT_RUN_INTERVAL_MINUTES` (5) into a DuckDB work DB, and publishes a dashboard-only read DB (`data/read/<CURRENT>/aura.duckdb`) for the Next.js dashboard.

---

## Routing

```
TRIVIAL request          → MAIN  (single-file edit, one-shot read, clarifying Q)
NON-TRIVIAL request      → runner  (sonnet, default delegate)
deep specialist work     → runner dispatches one of:
                            data-engineer | dbt-expert |
                            frontend-engineer | code-reviewer
```

MAIN's job in this repo is **decompose and dispatch**, not implement.
Implementation tokens live in subagents so they do not bloat MAIN's
context across turns.

Rationale (kept here so future-me does not undo it):
> 40k tokens in MAIN are paid for on *every* subsequent turn — full
> history re-submits. A subagent that compresses those 40k into a
> bounded summary (see runner return contract) pays for them once.

If runner's confidence is `L` or its summary is too thin to act on,
re-run runner with a tighter prompt. Don't guess from a low-confidence
return.

## Models

- **Sonnet** — default for everything.
- **Haiku** — mechanical bulk work only (mass renames, doc reformat,
  scaffolding from a template).
- **Opus** — explicit user instruction only (strategic judgment,
  deep design, multi-system trade-offs).

## Cordial mode (project-wide, all agents)

Before any change that:

- touches more than one file, **or**
- alters a schema (lake tables in `lake.py`, SQLite state, marts, `read_tables.sql`), **or**
- modifies a dbt model or `model_pricing.csv`, **or**
- deletes data or rewrites history

— summarize the intended change in one paragraph and wait for user
confirmation. Trivial edits (typo, single-line fix, comment) proceed
without asking.

## Karpathy principles (project-tailored)

These four principles apply to every agent. Each agent's `.md` file
also includes a role-tailored "applied" section with concrete Aura
examples (JSONL adapter pitfalls, SCD on pricing, etc.).

- **Think Before Coding.** Name the table, the dedup key, the seed
  row, the model id, and the failure mode *before* editing. The
  JSONL schema is undocumented and evolving; assumptions are
  expensive.

- **Simplicity First.** One adapter at a time. One dbt model at a
  time. Don't generalize a `claude.py` adapter into a plugin
  framework because Gemini is on the roadmap. Don't refactor `staging`
  into a macro library because two models share three lines.

- **Surgical Changes.** A watcher checkpoint change does not touch
  the dbt cycle. A frontend page change does not touch dbt.
  Different surfaces, different files.

- **Goal-Driven Execution.** Success is verified against the schema
  and the dashboard, not against "the script returned exit 0." A
  watcher change is verified by `SELECT count(*) FROM
  read_parquet('data/lake/raw_events/*/*.parquet') WHERE ingested_at >
  (now() AT TIME ZONE 'UTC') - INTERVAL 5 minutes` (naive UTC) (or `last_flush_at` in
  `data/artifacts/watcher_status.json`), not by stdout.

- **Don't Assume — Ask.** When a JSONL event type is unfamiliar or a
  cost number looks off, read the actual `.jsonl` file before
  patching. The schema has surprises (see the ground-truth notes in `.claude/agents/data-engineer.md`).

## Runner return contract (every runner reply ends with this)

```
+ confidence: <H|M|L> — <one line why>
+ verified:   <what ran or was read>
+ uncertain:  <what was not checked>
+ next:       <suggested next step, if any>
```

Target ~800–1500 tokens. Bounded, but not micro-compressed — bad
summaries cause bad MAIN decisions.

## Terminal is always free

All agent dispatches and long-running commands MUST run in the background
(`run_in_background: true` on Agent, or background mode on Bash). MAIN
never blocks the terminal waiting on a sub-process. The harness notifies
on completion — there is no need to poll. Foreground is reserved for
fast one-shot reads / edits (< a few seconds).

## Commit and push

```
edit → stage explicit paths → commit → push.
multi-file change : one commit, one push.
git add -A : never.
pre-PR : git pull origin main.
done == pushed.
```

## Surface map

| Path | Agent | Owns |
| --- | --- | --- |
| `watcher/` | data-engineer | JSONL adapters, Parquet lake writer, SQLite checkpoints, compaction, dbt cycle + publish, redaction |
| `dbt/` | dbt-expert | models, seeds, pricing SCD, tests |
| `frontend/` | frontend-engineer | Next.js dashboard, UI components |
| (all diffs) | code-reviewer | general code review |
| (orchestration) | runner | dispatch + bounded summary |
