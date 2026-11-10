"""One-time export of the legacy DuckDB (``data/aura.duckdb``) into the lake (spec §4).

    python -m aura_watcher.export_legacy --src data/aura.duckdb [--data-dir data] [--force]

The legacy DB is attached READ_ONLY and never written. Everything is staged in
``<data>/lake.export/`` and verified there before a single file moves into
the lake, because the lake becomes the only copy of anything older than 30 days.
"""

import argparse
import glob
import json
import os
import shutil
import sys
import time

import duckdb

from aura_watcher import lake
from aura_watcher.redact import redact_enabled, redact_payload, redact_title

LEGACY_TS = "2026-08-21 00:00:00"
BATCH = 10000
TABLES = ["raw_events", "raw_session_skills", "raw_session_mcps", "session_meta", "watcher_errors"]
_COPY_OPTS = "FORMAT parquet, COMPRESSION zstd, PARTITION_BY (\"date\"), ROW_GROUP_SIZE 100000"
_LTS = f"TIMESTAMP '{LEGACY_TS}'"

# Lake column -> legacy select expression (for the columns that are not copied as-is).
_EXPR = {
    "raw_events": {"file_path": "regexp_replace(r.file_path, '^/logs/claude/', 'claude/')",
                   "source": "COALESCE(r.source, 'claude')", "ingested_at": _LTS},
    "raw_session_skills": {"observed_at": _LTS, "ingested_at": _LTS},
    "raw_session_mcps": {"first_seen_at": f"COALESCE(first_seen_at, {_LTS})", "ingested_at": _LTS},
    "watcher_errors": {"ts": f"COALESCE(ts, {_LTS})", "ingested_at": _LTS},
}
_DATE = {"raw_session_skills": "DATE '2026-08-21'", "raw_session_mcps": "first_seen_at::DATE",
         "watcher_errors": "ts::DATE"}


def _q(p: str) -> str:
    return p.replace("\\", "/").replace("'", "''")


def _files(root: str, table: str, pattern: str = "*.parquet") -> list[str]:
    return sorted(glob.glob(os.path.join(root, table, "date=*", pattern)))


def _count(con, files: list[str], expr: str = "count(*)") -> int:
    if not files:
        return 0
    lst = ", ".join(f"'{_q(f)}'" for f in files)
    return con.execute(f"SELECT {expr} FROM read_parquet([{lst}], hive_partitioning = false)").fetchone()[0]


def _select(table: str, prefix: str = "") -> str:
    exprs = _EXPR.get(table, {})
    return ", ".join(f"{exprs[c]} AS {c}" if c in exprs else f"{prefix}{c}"
                     for c, _ in lake.SCHEMAS[table] if not (table == "raw_events" and c == "payload"))


def stage(con, stage_dir: str, work_dir: str) -> dict:
    """Write every legacy table into ``stage_dir``; returns the raw_events
    redaction counters."""
    for table in ("raw_session_skills", "raw_session_mcps", "watcher_errors"):
        con.execute(f"COPY (SELECT {_select(table)}, {_DATE[table]} AS \"date\" FROM src.{table}) "
                    f"TO '{_q(os.path.join(stage_dir, table))}' ({_COPY_OPTS}, FILENAME_PATTERN 'legacy-{{i}}')")
    raw = _stage_raw_events(con, stage_dir, work_dir)
    _stage_session_meta(con, stage_dir, work_dir)
    return raw


def _stage_raw_events(con, stage_dir: str, work_dir: str) -> dict:
    """U2: payloads go through the watcher's value-level redaction in 10,000-row
    rowid batches (Python UDFs would need numpy). Only changed payloads are
    written to the side file; the COPY joins them back on rowid."""
    ndjson = os.path.join(work_dir, "export.ndjson")
    n = con.execute("SELECT COALESCE(max(rowid) + 1, 0) FROM src.raw_events").fetchone()[0]
    redacting = redact_enabled()
    redacted = invalid = batches = 0
    for b, lo in enumerate(range(0, n, BATCH)):
        hi = lo + BATCH
        changed = 0
        with open(ndjson, "w", encoding="utf-8") as f:
            if redacting:
                rows = con.execute("SELECT rowid, payload, json_valid(payload) FROM src.raw_events "
                                   "WHERE rowid >= ? AND rowid < ?", [lo, hi]).fetchall()
                for rid, payload, valid in rows:
                    if not valid:
                        invalid += 1  # copied unchanged; stg_events keeps its TRY_CAST guard
                        continue
                    out = redact_payload(payload)
                    if out != payload:
                        f.write(json.dumps({"rid": rid, "payload": out}) + "\n")
                        changed += 1
        redacted += changed
        con.execute(f"""
            COPY (
              SELECT {_select('raw_events', 'r.')}, COALESCE(p.payload, r.payload) AS payload, r.ts::DATE AS "date"
              FROM src.raw_events r
              LEFT JOIN read_json('{_q(ndjson)}', format = 'newline_delimited',
                                  columns = {{rid: 'BIGINT', payload: 'VARCHAR'}},
                                  maximum_object_size = 268435456) p ON p.rid = r.rowid
              WHERE r.rowid >= {lo} AND r.rowid < {hi}
              ORDER BY r.tenant_id, r.session_id, r.ts
            ) TO '{_q(os.path.join(stage_dir, 'raw_events'))}'
              ({_COPY_OPTS}, FILENAME_PATTERN 'legacy-b{b:05d}-{{i}}', OVERWRITE_OR_IGNORE true)""")
        batches += 1
    if os.path.exists(ndjson):
        os.remove(ndjson)
    return {"redacted": redacted, "invalid_json": invalid, "batches": batches}


def _stage_session_meta(con, stage_dir: str, work_dir: str) -> None:
    """E5/S4: titles are redacted in Python; the legacy ingested_at becomes
    observed_at (and so the partition date, E6)."""
    have = {r[0] for r in con.execute("SELECT column_name FROM duckdb_columns() "
                                      "WHERE database_name = 'src' AND table_name = 'session_meta'").fetchall()}
    cols = ["tenant_id", "session_id", "person_id", "person_name", "session_title", "permission_mode", "mode"]
    sel = ", ".join(c if c in have else f"NULL AS {c}" for c in cols)
    rows = []
    for r in con.execute(f"SELECT {sel}, ingested_at FROM src.session_meta").fetchall():
        d = dict(zip(cols, r[:-1]))
        d["tenant_id"] = d["tenant_id"] or "local"
        d["session_title"] = redact_title(d["session_title"])
        d["observed_at"] = r[-1] or LEGACY_TS
        rows.append(lake.coerce_row("session_meta", d))
    if rows:
        lake.write_rows(stage_dir, "session_meta", rows, LEGACY_TS, os.path.join(work_dir, "export_meta.ndjson"),
                        prefix="legacy")


def verify(con, stage_dir: str, src_counts: dict) -> dict:
    """E2 + U2: per-table counts, and raw_events uuid sets equal both ways."""
    out = {"tables": {}, "ok": True}
    for t in TABLES:
        staged = _count(con, _files(stage_dir, t))
        out["tables"][t] = {"source": src_counts[t], "staged": staged}
        out["ok"] &= staged == src_counts[t]
    files = _files(stage_dir, "raw_events")
    out["raw_events_distinct"] = _count(con, files, "count(DISTINCT (tenant_id, uuid))")
    if files:
        lst = "read_parquet([" + ", ".join(f"'{_q(f)}'" for f in files) + "], hive_partitioning = false)"
        out["uuids_missing"] = con.execute(f"SELECT count(*) FROM (SELECT tenant_id, uuid FROM src.raw_events "
                                           f"EXCEPT SELECT tenant_id, uuid FROM {lst})").fetchone()[0]
        out["uuids_extra"] = con.execute(f"SELECT count(*) FROM (SELECT tenant_id, uuid FROM {lst} "
                                         f"EXCEPT SELECT tenant_id, uuid FROM src.raw_events)").fetchone()[0]
    else:
        out["uuids_missing"], out["uuids_extra"] = src_counts["raw_events"], 0
    out["ok"] &= (out["raw_events_distinct"] == src_counts["raw_events"]
                  and out["uuids_missing"] == 0 and out["uuids_extra"] == 0)
    return out


def merge(con, stage_dir: str, lake_dir: str, src_counts: dict, force: bool) -> bool:
    """E1/D1: move files, never directories; never touch non-legacy files."""
    if force:
        for t in TABLES:
            for f in _files(lake_dir, t, "legacy-*.parquet"):
                os.remove(f)
    for t in TABLES:
        for f in _files(stage_dir, t):
            target = os.path.join(lake_dir, os.path.relpath(f, stage_dir))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            os.replace(f, target)
    ok = True
    for t in TABLES:
        got = _count(con, _files(lake_dir, t, "legacy-*.parquet"))
        if got != src_counts[t]:
            print(f"[export] {t}: lake holds {got} legacy rows, expected {src_counts[t]}")
            ok = False
    return ok


def _append_verdicts(con, inbox: str) -> int:
    rows = con.execute("SELECT tenant_id, session_id, verdict, note, created_at FROM src.session_verdicts").fetchall()
    if rows:
        os.makedirs(os.path.dirname(inbox), exist_ok=True)
        with open(inbox, "a", encoding="utf-8") as f:
            for tenant, sid, verdict, note, created in rows:
                f.write(json.dumps({"tenant_id": tenant or "local", "session_id": sid, "verdict": verdict,
                                    "note": note, "created_at": lake.to_ts(created).replace(" ", "T") + "Z"}) + "\n")
    return len(rows)


def export(src: str, data_dir: str, lake_dir: str, inbox: str, force: bool = False) -> int:
    t0 = time.time()
    foreign = [f for t in TABLES for f in _files(lake_dir, t)
               if not os.path.basename(f).startswith("legacy-") and os.path.basename(f) != lake.EMPTY_FILE]
    if foreign and not force:
        print(f"[export] lake already holds {len(foreign)} non-legacy file(s) (e.g. {foreign[0]}); "
              "refusing. --force merges anyway and never deletes them.")
        return 1

    work_dir = os.path.join(data_dir, "work")
    tmp_dir = os.path.join(work_dir, "export.tmp")
    stage_dir = os.path.join(data_dir, "lake.export")
    os.makedirs(tmp_dir, exist_ok=True)
    shutil.rmtree(stage_dir, ignore_errors=True)
    os.makedirs(stage_dir)

    con = duckdb.connect()
    con.execute(f"SET memory_limit = '4GB'; SET temp_directory = '{_q(tmp_dir)}'; "
                "SET preserve_insertion_order = false")
    try:
        con.execute(f"ATTACH '{_q(src)}' AS src (READ_ONLY)")
    except duckdb.Error as e:
        print(f"[export] cannot open {src} read-only: {e}. Stop and check; there is no read-write fallback.")
        return 1
    src_counts = {t: con.execute(f"SELECT count(*) FROM src.{t}").fetchone()[0]
                  for t in TABLES + ["session_verdicts"]}
    print(f"[export] source rows: {src_counts}", flush=True)

    raw = stage(con, stage_dir, work_dir)
    report = verify(con, stage_dir, src_counts)
    report.update(raw_events=raw, seconds=round(time.time() - t0, 1), src=src)
    art = os.path.join(data_dir, "artifacts")
    os.makedirs(art, exist_ok=True)
    with open(os.path.join(art, "export_legacy.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    print(json.dumps(report, indent=1), flush=True)
    if not report["ok"]:
        print("[export] verification failed; the lake was not touched (staging kept)")
        return 1

    if not merge(con, stage_dir, lake_dir, src_counts, force):
        return 1
    verdicts = _append_verdicts(con, inbox)
    con.close()
    shutil.rmtree(stage_dir, ignore_errors=True)
    shutil.rmtree(tmp_dir, ignore_errors=True)
    lake.ensure_tables(lake_dir)
    print(f"[export] merged into {lake_dir}; {verdicts} verdict(s) appended to {inbox}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="aura_watcher.export_legacy")
    ap.add_argument("--src", required=True)
    ap.add_argument("--data-dir", default=os.getenv("AURA_DATA_DIR", "/data"))
    ap.add_argument("--force", action="store_true", help="merge although the lake has non-legacy files")
    args = ap.parse_args(argv)
    data = os.path.abspath(args.data_dir)
    lake_dir = os.path.abspath(os.getenv("AURA_LAKE_DIR", os.path.join(data, "lake")))
    inbox = os.path.abspath(os.getenv("AURA_VERDICTS_INBOX", os.path.join(data, "inbox", "verdicts-inbox.jsonl")))
    return export(os.path.abspath(args.src), data, lake_dir, inbox, args.force)


if __name__ == "__main__":
    sys.exit(main())
