"""Watcher state in SQLite: per-file checkpoints, file stats and a small meta
table. One connection, owned by the ingest thread.

journal_mode=DELETE because WAL's -shm mmap is unreliable on Docker Desktop
bind mounts.
"""

import os
import sqlite3

from aura_watcher.lake import utcnow

_DDL = """
CREATE TABLE IF NOT EXISTS checkpoints(
  tenant_id TEXT NOT NULL DEFAULT 'local', file_path TEXT NOT NULL,
  last_offset INTEGER NOT NULL, head_len INTEGER, head_hash TEXT,
  last_line_uuid TEXT, sdk_anchor_ts TEXT, last_seen_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, file_path));
CREATE TABLE IF NOT EXISTS file_stats(
  tenant_id TEXT NOT NULL DEFAULT 'local', file_path TEXT NOT NULL,
  lines_total INTEGER DEFAULT 0, events_kept INTEGER DEFAULT 0, dropped_known INTEGER DEFAULT 0,
  dropped_unknown INTEGER DEFAULT 0, parse_errors INTEGER DEFAULT 0, last_error TEXT, updated_at TEXT,
  PRIMARY KEY(tenant_id, file_path));
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
"""

STAT_COLS = ("lines_total", "events_kept", "dropped_known", "dropped_unknown", "parse_errors")
CP_COLS = ("last_offset", "head_len", "head_hash", "last_line_uuid", "sdk_anchor_ts", "last_seen_at")


def open_state(path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=DELETE")
    con.execute("PRAGMA synchronous=FULL")
    con.executescript(_DDL)
    return con


def load_checkpoints(con) -> dict[str, dict]:
    rows = con.execute(f"SELECT file_path, {', '.join(CP_COLS)} FROM checkpoints WHERE tenant_id = 'local'")
    return {r[0]: dict(zip(CP_COLS, r[1:])) for r in rows}


def load_file_stats(con) -> dict[str, dict]:
    cols = STAT_COLS + ("last_error",)
    rows = con.execute(f"SELECT file_path, {', '.join(cols)} FROM file_stats WHERE tenant_id = 'local'")
    return {r[0]: dict(zip(cols, r[1:])) for r in rows}


def commit_flush(con, pending: dict[str, dict]) -> None:
    """One transaction: upsert each pending checkpoint, then its stats delta
    (``reset`` replaces the counters, otherwise they are added)."""
    now = utcnow().isoformat()
    sets = ", ".join(f"{c} = CASE WHEN :reset THEN excluded.{c} ELSE file_stats.{c} + excluded.{c} END"
                     for c in STAT_COLS)
    with con:
        for fp, p in pending.items():
            con.execute(
                f"INSERT INTO checkpoints(file_path, {', '.join(CP_COLS)}) VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(tenant_id, file_path) DO UPDATE SET "
                + ", ".join(f"{c} = excluded.{c}" for c in CP_COLS),
                [fp, p["last_offset"], p["head_len"], p["head_hash"], p["last_line_uuid"], p["sdk_anchor_ts"], now],
            )
            s = p["stats"]
            if not s["reset"] and not any(s[c] for c in STAT_COLS):
                continue
            con.execute(
                f"INSERT INTO file_stats(file_path, {', '.join(STAT_COLS)}, last_error, updated_at) "
                f"VALUES (:fp, {', '.join(':' + c for c in STAT_COLS)}, :last_error, :now) "
                f"ON CONFLICT(tenant_id, file_path) DO UPDATE SET {sets}, "
                "last_error = CASE WHEN :reset THEN excluded.last_error "
                "ELSE COALESCE(excluded.last_error, file_stats.last_error) END, updated_at = excluded.updated_at",
                {**s, "fp": fp, "now": now},
            )


def get_meta(con, key: str, default=None):
    row = con.execute("SELECT value FROM meta WHERE key = ?", [key]).fetchone()
    return row[0] if row else default


def set_meta(con, key: str, value: str) -> None:
    with con:
        con.execute("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [key, value])
