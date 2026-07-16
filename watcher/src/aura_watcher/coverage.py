"""Ingest coverage snapshot writer.

Produces per-UTC-day JSON files and a rolling latest.json under
<artifacts_dir>/ingest_coverage/ describing how much of the JSONL corpus
has been ingested.

CONTRACT (frontend reads these files):
  /data/artifacts/ingest_coverage/<YYYY-MM-DD>.json  — one per day, kept 30 days
  /data/artifacts/ingest_coverage/latest.json        — always the most recent snapshot

JSON shape:
{
  "generated_at": "<ISO8601 UTC>",
  "scan_dirs": [...],
  "summary": {
    "files_total": int, "files_full": int, "files_partial": int,
    "files_unprocessed": int,
    "bytes_total": int, "bytes_ingested": int, "bytes_remaining": int,
    "events_kept": int, "lines_dropped_known": int,
    "lines_dropped_unknown": int, "parse_errors": int
  },
  "files": [   // ONLY partial + unprocessed, sorted by bytes_remaining desc
    { "path": str, "size": int, "offset": int, "status": "partial"|"unprocessed",
      "bytes_remaining": int, "last_seen_at": "ISO8601|null",
      "lines_total": int|null, "events_kept": int|null, "dropped_known": int|null,
      "dropped_unknown": int|null, "parse_errors": int|null, "last_error": str|null }
  ]
}

Status rules:
  offset >= size  -> "full"
  0 < offset < size -> "partial"
  no checkpoint row -> "unprocessed" (offset = 0)

Caller is responsible for holding _snapshot_lock around this call so the
DB reads are safe from concurrent dbt subprocess access.
"""

import json
import os
from datetime import datetime, timezone


def write_coverage(
    writer,
    all_files: list[str],
    artifacts_dir: str,
    scan_dirs: list[str] | None = None,
) -> None:
    """Compute and persist the ingest coverage snapshot.

    Parameters
    ----------
    writer:
        DuckDBWriter instance (already initialised). Used for its
        get_connection() context manager to read checkpoint and stats tables.
    all_files:
        Deduplicated list of absolute .jsonl paths from all scan dirs.
        Caller performs the glob OUTSIDE the lock; this function only reads DB.
    artifacts_dir:
        Root artifacts directory (e.g. /data/artifacts). The subdirectory
        ingest_coverage/ is created if absent.
    scan_dirs:
        The directories that were globbed to produce all_files. Echoed into
        the artifact's top-level ``scan_dirs`` field (part of the contract the
        frontend reads); defaults to an empty list when not supplied.
    """
    now_utc = datetime.now(timezone.utc)

    # ------------------------------------------------------------------ #
    # 1. Read checkpoints (file_path -> {last_offset, last_seen_at})      #
    # ------------------------------------------------------------------ #
    checkpoints: dict[str, dict] = {}
    with writer.get_connection() as conn:
        rows = conn.execute(
            "SELECT file_path, last_offset, last_seen_at FROM ingest_checkpoints"
        ).fetchall()
    for file_path, last_offset, last_seen_at in rows:
        checkpoints[file_path] = {
            "last_offset": last_offset,
            "last_seen_at": last_seen_at,
        }

    # ------------------------------------------------------------------ #
    # 2. Read per-file stats (file_path -> stats dict)                    #
    # ------------------------------------------------------------------ #
    file_stats: dict[str, dict] = {}
    with writer.get_connection() as conn:
        stat_rows = conn.execute(
            """SELECT file_path, lines_total, events_kept,
                      dropped_known, dropped_unknown, parse_errors, last_error
               FROM ingest_file_stats"""
        ).fetchall()
    for (fp, lt, ek, dk, du, pe, le) in stat_rows:
        file_stats[fp] = {
            "lines_total": lt,
            "events_kept": ek,
            "dropped_known": dk,
            "dropped_unknown": du,
            "parse_errors": pe,
            "last_error": le,
        }

    # ------------------------------------------------------------------ #
    # 3. Per-file classification                                          #
    # ------------------------------------------------------------------ #
    summary = {
        "files_total": 0,
        "files_full": 0,
        "files_partial": 0,
        "files_unprocessed": 0,
        "bytes_total": 0,
        "bytes_ingested": 0,
        "bytes_remaining": 0,
        "events_kept": 0,
        "lines_dropped_known": 0,
        "lines_dropped_unknown": 0,
        "parse_errors": 0,
    }
    remaining_files: list[dict] = []

    for fp in all_files:
        try:
            size = os.path.getsize(fp)
        except OSError:
            # File disappeared between glob and now — skip silently.
            continue

        summary["files_total"] += 1
        summary["bytes_total"] += size

        cp = checkpoints.get(fp)
        offset = cp["last_offset"] if cp else 0
        last_seen_at = cp["last_seen_at"] if cp else None

        # Clamp offset to size in case the file shrank and checkpoint wasn't
        # reset yet (the watcher resets on next process_file, not here).
        ingested = min(offset, size)
        remaining = size - ingested

        summary["bytes_ingested"] += ingested
        summary["bytes_remaining"] += remaining

        # Status classification.
        if cp is None:
            status = "unprocessed"
            summary["files_unprocessed"] += 1
        elif offset >= size:
            status = "full"
            summary["files_full"] += 1
        else:
            status = "partial"
            summary["files_partial"] += 1

        # Aggregate stats from ingest_file_stats (may be absent for files
        # not yet processed at all).
        st = file_stats.get(fp)
        if st:
            summary["events_kept"] += st["events_kept"] or 0
            summary["lines_dropped_known"] += st["dropped_known"] or 0
            summary["lines_dropped_unknown"] += st["dropped_unknown"] or 0
            summary["parse_errors"] += st["parse_errors"] or 0

        # Only partial + unprocessed go into the files[] array.
        if status in ("partial", "unprocessed"):
            # Serialise last_seen_at to ISO8601 string (it may be a datetime
            # object from DuckDB or already a string, depending on the driver).
            if last_seen_at is not None and hasattr(last_seen_at, "isoformat"):
                last_seen_at_str: str | None = last_seen_at.isoformat()
            elif last_seen_at is not None:
                last_seen_at_str = str(last_seen_at)
            else:
                last_seen_at_str = None

            entry: dict = {
                "path": fp,
                "size": size,
                "offset": offset,
                "status": status,
                "bytes_remaining": remaining,
                "last_seen_at": last_seen_at_str,
                "lines_total": st["lines_total"] if st else None,
                "events_kept": st["events_kept"] if st else None,
                "dropped_known": st["dropped_known"] if st else None,
                "dropped_unknown": st["dropped_unknown"] if st else None,
                "parse_errors": st["parse_errors"] if st else None,
                "last_error": st["last_error"] if st else None,
            }
            remaining_files.append(entry)

    # Sort remaining work by bytes_remaining descending (biggest gap first).
    remaining_files.sort(key=lambda e: e["bytes_remaining"], reverse=True)

    # ------------------------------------------------------------------ #
    # 4. Build JSON payload                                               #
    # ------------------------------------------------------------------ #
    payload = {
        "generated_at": now_utc.isoformat(),
        "scan_dirs": list(scan_dirs) if scan_dirs else [],
        "summary": summary,
        "files": remaining_files,
    }

    # ------------------------------------------------------------------ #
    # 5. Write files atomically (tmp + os.replace)                        #
    # ------------------------------------------------------------------ #
    out_dir = os.path.join(artifacts_dir, "ingest_coverage")
    os.makedirs(out_dir, exist_ok=True)

    date_str = now_utc.strftime("%Y-%m-%d")
    dated_path = os.path.join(out_dir, f"{date_str}.json")
    latest_path = os.path.join(out_dir, "latest.json")

    payload_str = json.dumps(payload, default=str)

    for target in (dated_path, latest_path):
        tmp_path = target + ".tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as fh:
                fh.write(payload_str)
            os.replace(tmp_path, target)
        except Exception:
            # Clean up the tmp file if replace failed.
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            raise

    # ------------------------------------------------------------------ #
    # 6. Rotate: keep only the last 30 dated files                        #
    # ------------------------------------------------------------------ #
    try:
        dated_files = sorted(
            f for f in os.listdir(out_dir)
            if f.endswith(".json") and f != "latest.json"
        )
        for stale in dated_files[:-30]:
            try:
                os.remove(os.path.join(out_dir, stale))
            except OSError:
                pass
    except OSError:
        pass
