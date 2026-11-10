"""Parquet lake: schemas (the watcher -> dbt contract, spec §1.2), atomic
writes, the empty schema file per table, and compaction (§1.4).

All Parquet I/O goes through an in-memory DuckDB connection; the partition
column ``date`` lives only in the directory name.
"""

import glob
import json
import os
import threading
import traceback
from datetime import UTC, datetime

import duckdb

_EVENT_COLS = [
    ("tenant_id", "VARCHAR"), ("uuid", "VARCHAR"), ("session_id", "VARCHAR"), ("project_id", "VARCHAR"),
    ("agent", "VARCHAR"), ("event_type", "VARCHAR"), ("ts", "TIMESTAMP"), ("file_path", "VARCHAR"),
    ("byte_offset", "BIGINT"), ("parent_uuid", "VARCHAR"), ("request_id", "VARCHAR"), ("message_id", "VARCHAR"),
    ("is_sidechain", "BOOLEAN"), ("stop_reason", "VARCHAR"), ("cwd", "VARCHAR"), ("git_branch", "VARCHAR"),
    ("claude_version", "VARCHAR"), ("model", "VARCHAR"), ("input_tokens", "INTEGER"), ("output_tokens", "INTEGER"),
    ("cache_creation_input_tokens", "INTEGER"), ("ephemeral_5m_input_tokens", "INTEGER"),
    ("ephemeral_1h_input_tokens", "INTEGER"), ("cache_read_input_tokens", "INTEGER"), ("context_pct", "DOUBLE"),
    ("source", "VARCHAR"), ("reported_cost_usd", "DOUBLE"), ("payload", "VARCHAR"), ("ingested_at", "TIMESTAMP"),
]

SCHEMAS = {
    "raw_events": _EVENT_COLS,
    "raw_session_skills": [
        ("tenant_id", "VARCHAR"), ("session_id", "VARCHAR"), ("skill_name", "VARCHAR"), ("is_initial", "BOOLEAN"),
        ("observed_at", "TIMESTAMP"), ("ingested_at", "TIMESTAMP"),
    ],
    "raw_session_mcps": [
        ("tenant_id", "VARCHAR"), ("session_id", "VARCHAR"), ("mcp_server", "VARCHAR"),
        ("first_seen_at", "TIMESTAMP"), ("ingested_at", "TIMESTAMP"),
    ],
    "session_meta": [
        ("tenant_id", "VARCHAR"), ("session_id", "VARCHAR"), ("person_id", "VARCHAR"), ("person_name", "VARCHAR"),
        ("session_title", "VARCHAR"), ("permission_mode", "VARCHAR"), ("mode", "VARCHAR"),
        ("observed_at", "TIMESTAMP"), ("ingested_at", "TIMESTAMP"),
    ],
    "watcher_errors": [
        ("ts", "TIMESTAMP"), ("source", "VARCHAR"), ("file_path", "VARCHAR"), ("error_message", "VARCHAR"),
        ("stack_trace", "VARCHAR"), ("ingested_at", "TIMESTAMP"),
    ],
}

KEYS = {
    "raw_events": ["tenant_id", "uuid"],
    "raw_session_skills": ["tenant_id", "session_id", "skill_name"],
    "raw_session_mcps": ["tenant_id", "session_id", "mcp_server"],
    "session_meta": None,
    "watcher_errors": None,
}

PARTITION_COL = {
    "raw_events": "ts",
    "raw_session_skills": "observed_at",
    "raw_session_mcps": "first_seen_at",
    "session_meta": "observed_at",
    "watcher_errors": "ts",
}

# ingested_at is stamped at flush time, so it is not checked by coerce_row.
REQUIRED = {
    "raw_events": {"tenant_id", "uuid", "session_id", "agent", "event_type", "ts", "file_path", "byte_offset",
                   "is_sidechain", "source", "payload"},
    "raw_session_skills": {"tenant_id", "session_id", "skill_name", "observed_at"},
    "raw_session_mcps": {"tenant_id", "session_id", "mcp_server", "first_seen_at"},
    "session_meta": {"tenant_id", "session_id", "observed_at"},
    "watcher_errors": {"ts"},
}

EMPTY_PARTITION = "date=1970-01-01"
EMPTY_FILE = "part-empty.parquet"
TS_FORMAT = "%Y-%m-%d %H:%M:%S.%f"
_INT_RANGE = {"INTEGER": 2**31, "BIGINT": 2**63}

# flush_lock: held by a flush from stamping ingested_at until its last file is in
# place, so a dbt cutoff taken under it sees every row stamped before it (C1).
# lake_lock: held by compaction and by the dbt cycle (seed + run + publish).
flush_lock = threading.Lock()
lake_lock = threading.Lock()

_bad_partitions: set[str] = set()


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def to_ts(v) -> str:
    """Naive UTC text for a datetime or ISO string; a naive input is taken as UTC (Q2)."""
    if isinstance(v, str):
        v = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    if not isinstance(v, datetime):
        raise ValueError(f"not a timestamp: {v!r}")
    if v.tzinfo is not None:
        v = v.astimezone(UTC).replace(tzinfo=None)
    return v.strftime(TS_FORMAT)


def _coerce(v, typ: str):
    if v is None:
        return None
    if typ == "VARCHAR":
        s = v if isinstance(v, str) else str(v)
        try:
            s.encode("utf-8")
        except UnicodeEncodeError:
            # A lone surrogate makes DuckDB's JSON reader reject the whole flush file.
            s = s.encode("utf-8", "replace").decode("utf-8")
        return s
    if typ == "TIMESTAMP":
        return to_ts(v)
    if typ == "BOOLEAN":
        return bool(v)
    if typ in _INT_RANGE:
        if isinstance(v, float) and not v.is_integer():
            raise ValueError(f"not an integer: {v!r}")
        i = int(v)
        if not -_INT_RANGE[typ] <= i < _INT_RANGE[typ]:
            raise ValueError(f"{typ} out of range: {i}")
        return i
    if typ == "DOUBLE":
        return float(v)
    raise ValueError(f"unknown type {typ}")


def coerce_row(table: str, row: dict) -> dict:
    """Row with every schema column (except ingested_at) coerced to its type.
    Raises ValueError when a required column is missing or fails coercion (S1);
    an optional column that fails coercion becomes NULL."""
    required = REQUIRED[table]
    out = {}
    for col, typ in SCHEMAS[table]:
        if col == "ingested_at":
            continue
        v = row.get(col)
        if v is None and typ == "BOOLEAN" and col in required:
            v = False  # isSidechain: null -> False
        try:
            out[col] = _coerce(v, typ)
        except (TypeError, ValueError, OverflowError) as e:
            if col in required:
                raise ValueError(f"{table}.{col}: {e}") from None
            out[col] = None
        if out[col] is None and col in required:
            raise ValueError(f"{table}.{col} is missing")
    return out


def _ndjson_columns(table: str) -> str:
    return "{" + ", ".join(f"{c}: '{t}'" for c, t in SCHEMAS[table]) + "}"


def _replace_tmp(con, select_sql: str, target: str) -> None:
    tmp = target + ".tmp"
    try:
        con.execute(f"COPY ({select_sql}) TO '{tmp}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)")
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def write_rows(root: str, table: str, rows: list[dict], ingested_at: str, scratch: str,
               prefix: str = "part") -> list[str]:
    """Write coerced rows to ``<root>/<table>/date=<d>/<prefix>-<stamp>-<seq>.parquet``,
    one file per partition date, each via ``.tmp`` + ``os.replace``."""
    by_date: dict[str, list[dict]] = {}
    pcol = PARTITION_COL[table]
    for r in rows:
        by_date.setdefault(r[pcol][:10], []).append(r)
    cols = ", ".join(c for c, _ in SCHEMAS[table])
    stamp = utcnow().strftime("%Y%m%dT%H%M%S%fZ")
    os.makedirs(os.path.dirname(scratch), exist_ok=True)
    written = []
    con = duckdb.connect()
    try:
        for seq, (d, part) in enumerate(sorted(by_date.items())):
            with open(scratch, "w", encoding="utf-8") as f:
                for r in part:
                    f.write(json.dumps({**r, "ingested_at": ingested_at}) + "\n")
            out_dir = os.path.join(root, table, f"date={d}")
            os.makedirs(out_dir, exist_ok=True)
            target = os.path.join(out_dir, f"{prefix}-{stamp}-{seq:03d}.parquet")
            sel = (f"SELECT {cols} FROM read_json('{_sql_path(scratch)}', format='newline_delimited', "
                   f"columns={_ndjson_columns(table)}, maximum_object_size=268435456)")
            _replace_tmp(con, sel, _sql_path(target))
            written.append(target)
    finally:
        con.close()
    return written


def _sql_path(p: str) -> str:
    return p.replace("\\", "/").replace("'", "''")


def ensure_tables(lake_dir: str) -> None:
    """Every table always has a zero-row schema file: read_parquet errors on a
    glob with no matches, and watcher_errors can stay empty indefinitely."""
    con = duckdb.connect()
    try:
        for table, cols in SCHEMAS.items():
            d = os.path.join(lake_dir, table, EMPTY_PARTITION)
            target = os.path.join(d, EMPTY_FILE)
            if os.path.exists(target):
                continue
            os.makedirs(d, exist_ok=True)
            sel = "SELECT " + ", ".join(f"NULL::{t} AS {c}" for c, t in cols) + " LIMIT 0"
            _replace_tmp(con, sel, _sql_path(target))
    finally:
        con.close()


def clean_tmp(lake_dir: str) -> int:
    n = 0
    for root, _, files in os.walk(lake_dir):
        for name in files:
            if name.endswith(".tmp"):
                try:
                    os.remove(os.path.join(root, name))
                    n += 1
                except OSError:
                    pass
    return n


def parquet_rows(con, path: str) -> int:
    return con.execute(f"SELECT count(*) FROM read_parquet('{_sql_path(path)}')").fetchone()[0]


def _dedup_sql(table: str, src: str) -> tuple[str, str]:
    """(select of the compacted rows, query for the row count it must have)."""
    cols = ", ".join(c for c, _ in SCHEMAS[table])
    if table == "raw_events":
        return (f"SELECT {cols} FROM {src} QUALIFY row_number() OVER (PARTITION BY tenant_id, uuid "
                f"ORDER BY ingested_at DESC) = 1 ORDER BY tenant_id, session_id, ts",
                f"SELECT count(DISTINCT (tenant_id, uuid)) FROM {src}")
    if KEYS[table]:
        key = ", ".join(KEYS[table])
        first = PARTITION_COL[table]
        return (f"SELECT {cols} FROM {src} QUALIFY row_number() OVER (PARTITION BY {key} "
                f"ORDER BY {first}, ingested_at) = 1",
                f"SELECT count(DISTINCT ({key})) FROM {src}")
    return (f"SELECT DISTINCT {cols} FROM {src}", f"SELECT count(*) FROM (SELECT DISTINCT {cols} FROM {src})")


def compact(lake_dir: str, today: str, work_dir: str, min_files: int, log_error) -> bool:
    """Merge partitions with many small files (§1.4). Returns False when the
    dbt cycle holds lake_lock (nothing done)."""
    if not lake_lock.acquire(blocking=False):
        return False
    try:
        con = duckdb.connect()
        tmp_dir = os.path.join(work_dir, "compact.tmp")
        os.makedirs(tmp_dir, exist_ok=True)
        con.execute(f"SET memory_limit = '1GB'; SET temp_directory = '{_sql_path(tmp_dir)}'")
        try:
            for table in SCHEMAS:
                for part_dir in sorted(glob.glob(os.path.join(lake_dir, table, "date=*"))):
                    _compact_partition(con, table, part_dir, today, min_files, log_error)
        finally:
            con.close()
        return True
    finally:
        lake_lock.release()


def _compact_partition(con, table, part_dir, today, min_files, log_error) -> None:
    d = os.path.basename(part_dir)[len("date="):]
    if d == "1970-01-01" or part_dir in _bad_partitions:
        return
    files = sorted(glob.glob(os.path.join(part_dir, "*.parquet")))
    if not ((d < today and len(files) >= 2) or len(files) >= min_files):
        return
    src = ("read_parquet([" + ", ".join(f"'{_sql_path(f)}'" for f in files) + "], "
           "hive_partitioning = false, union_by_name = true)")
    select_sql, count_sql = _dedup_sql(table, src)
    target = os.path.join(part_dir, f"compacted-{utcnow().strftime('%Y%m%dT%H%M%S%fZ')}.parquet")
    try:
        expected = con.execute(count_sql).fetchone()[0]
        _replace_tmp(con, select_sql, _sql_path(target))
        got = parquet_rows(con, target)
    except Exception as e:
        _bad_partitions.add(part_dir)
        log_error("compaction", part_dir, str(e), traceback.format_exc())
        return
    if got != expected:
        # E3: never delete inputs on a mismatch; the lake may be the only copy.
        os.remove(target)
        _bad_partitions.add(part_dir)
        log_error("compaction", part_dir, f"compacted {got} rows, expected {expected}; inputs kept", None)
        return
    for f in files:
        try:
            os.remove(f)
        except OSError as e:
            # Windows: a reader may hold the file. The next run compacts again; dedup keeps it correct.
            print(f"[compaction] could not delete {f}: {e}")
