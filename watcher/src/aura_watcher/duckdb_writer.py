import logging
import traceback
from contextlib import contextmanager

import duckdb

logger = logging.getLogger(__name__)

class DuckDBWriter:
    def __init__(self, db_path: str):
        self.db_path = db_path
        # Set only while a persistent_connection() context is active (backfill
        # phase). None the rest of the time — see get_connection() below.
        self._persistent_conn = None
        self._init_db()

    @contextmanager
    def persistent_connection(self):
        """Hold ONE open connection for the duration of this context and make
        get_connection() (used by every writer/checkpoint method) transparently
        reuse it instead of connect/close-per-call.

        Intended ONLY for the synchronous initial-backfill phase in main.py,
        which runs single-threaded BEFORE the observer, the dbt/snapshot/
        coverage worker threads, and the _history_backfill thread start. During
        backfill dbt is not running, so there is no lock-release-for-dbt
        requirement (see the design note in get_connection()) — a single
        long-lived connection is safe there.

        Do NOT wrap anything that runs concurrently with another thread that
        also calls get_connection(): this connection is not shared/locked
        across threads, and once the periodic workers start, per-op
        connect/close must resume so dbt (a separate OS process) can acquire
        the DuckDB file lock between watcher writes.
        """
        if self._persistent_conn is not None:
            # Defensive: nested activation reuses the existing connection and
            # does not close it early on the inner context's exit.
            yield self._persistent_conn
            return
        conn = duckdb.connect(self.db_path)
        self._persistent_conn = conn
        try:
            yield conn
        finally:
            self._persistent_conn = None
            conn.close()

    @contextmanager
    def get_connection(self):
        # Design note (W-M5): per-call connect/close is intentional, NOT an
        # oversight.  DuckDB enforces a single-process write lock on the DB file.
        # A long-lived watcher connection would hold that lock continuously,
        # blocking dbt — a separate OS process — from opening aura.duckdb at all
        # and breaking the 5-minute dbt cycle entirely.  By closing the connection
        # after every operation the watcher fully releases the lock so dbt can
        # acquire it between watcher writes.
        #
        # The overhead (a few µs per open/close) is acceptable: the watcher is
        # I/O-bound on JSONL reads, not on connection setup.
        #
        # If pooling is ever introduced it MUST release the connection around dbt
        # cycle windows (i.e. not hold a connection open across the dbt subprocess
        # invocation).  Do not add pooling without profiling that constraint first.
        #
        # EXCEPTION: while persistent_connection() is active (initial backfill
        # only — single-threaded, pre-observer, pre-dbt-worker) we hand out the
        # shared long-lived connection and skip the close, since there is no
        # dbt subprocess running yet to release the lock for.
        if self._persistent_conn is not None:
            yield self._persistent_conn
            return
        conn = duckdb.connect(self.db_path)
        try:
            yield conn
        finally:
            conn.close()

    def _init_db(self):
        with self.get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS raw_events (
                    tenant_id        TEXT NOT NULL DEFAULT 'local',
                    uuid             TEXT NOT NULL,
                    session_id       TEXT NOT NULL,
                    project_id       TEXT,
                    agent            TEXT NOT NULL,
                    event_type       TEXT NOT NULL,
                    ts               TIMESTAMP NOT NULL,
                    file_path        TEXT NOT NULL,
                    byte_offset      BIGINT NOT NULL,
                    parent_uuid      TEXT,
                    request_id       TEXT,
                    message_id       TEXT,
                    is_sidechain     BOOLEAN NOT NULL DEFAULT FALSE,
                    stop_reason      TEXT,
                    cwd              TEXT,
                    git_branch       TEXT,
                    claude_version   TEXT,
                    model            TEXT,
                    input_tokens     INTEGER,
                    output_tokens    INTEGER,
                    cache_creation_input_tokens INTEGER,
                    ephemeral_5m_input_tokens   INTEGER,
                    ephemeral_1h_input_tokens   INTEGER,
                    cache_read_input_tokens     INTEGER,
                    context_pct      DOUBLE,
                    source           TEXT DEFAULT 'claude',
                    reported_cost_usd DOUBLE,
                    payload          VARCHAR NOT NULL,
                    PRIMARY KEY (tenant_id, uuid)
                );
                CREATE TABLE IF NOT EXISTS ingest_checkpoints (
                    tenant_id        TEXT NOT NULL DEFAULT 'local',
                    file_path        TEXT NOT NULL,
                    last_offset      BIGINT NOT NULL,
                    last_line_uuid   TEXT,
                    last_seen_at     TIMESTAMP NOT NULL,
                    PRIMARY KEY (tenant_id, file_path)
                );
                CREATE TABLE IF NOT EXISTS session_meta (
                    session_id    TEXT PRIMARY KEY,
                    tenant_id     TEXT NOT NULL DEFAULT 'local',
                    person_id     TEXT,
                    person_name   TEXT,
                    commits       INTEGER DEFAULT 0,
                    session_title TEXT,
                    ingested_at   TIMESTAMP DEFAULT now()
                );
                CREATE TABLE IF NOT EXISTS raw_session_skills (
                    tenant_id     TEXT NOT NULL DEFAULT 'local',
                    session_id    TEXT NOT NULL,
                    skill_name    TEXT NOT NULL,
                    is_initial    BOOLEAN DEFAULT FALSE,
                    PRIMARY KEY (tenant_id, session_id, skill_name)
                );
                CREATE TABLE IF NOT EXISTS raw_session_mcps (
                    tenant_id     TEXT NOT NULL DEFAULT 'local',
                    session_id    TEXT NOT NULL,
                    mcp_server    TEXT NOT NULL,
                    first_seen_at TIMESTAMP DEFAULT now(),
                    PRIMARY KEY (tenant_id, session_id, mcp_server)
                );
                CREATE TABLE IF NOT EXISTS watcher_errors (
                    ts            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    source        VARCHAR,
                    file_path     VARCHAR,
                    error_message VARCHAR,
                    stack_trace   VARCHAR
                );
                CREATE INDEX IF NOT EXISTS idx_watcher_errors_ts ON watcher_errors(ts);
                CREATE TABLE IF NOT EXISTS session_verdicts (
                    session_id   TEXT NOT NULL,
                    tenant_id    TEXT NOT NULL DEFAULT 'local',
                    verdict      TEXT NOT NULL,
                    note         TEXT,
                    created_at   TIMESTAMP NOT NULL DEFAULT now(),
                    PRIMARY KEY (tenant_id, session_id)
                );
                CREATE TABLE IF NOT EXISTS ingest_file_stats (
                    tenant_id        TEXT NOT NULL DEFAULT 'local',
                    file_path        TEXT NOT NULL,
                    lines_total      BIGINT DEFAULT 0,
                    events_kept      BIGINT DEFAULT 0,
                    dropped_known    BIGINT DEFAULT 0,
                    dropped_unknown  BIGINT DEFAULT 0,
                    parse_errors     BIGINT DEFAULT 0,
                    last_error       TEXT,
                    updated_at       TIMESTAMP DEFAULT now(),
                    PRIMARY KEY (tenant_id, file_path)
                );
            """)

            # Idempotent migrations so DBs created before the SDK-trace work
            # gain the new columns without a manual rebuild. DuckDB 1.5.1
            # supports ADD COLUMN IF NOT EXISTS; each statement is wrapped in
            # try/except so a future engine that doesn't support the clause
            # (or a column that already exists in some other form) never blocks
            # watcher startup.
            for ddl in (
                "ALTER TABLE raw_events ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'claude'",
                "ALTER TABLE raw_events ADD COLUMN IF NOT EXISTS reported_cost_usd DOUBLE",
                "ALTER TABLE session_meta ADD COLUMN IF NOT EXISTS permission_mode TEXT",
                "ALTER TABLE session_meta ADD COLUMN IF NOT EXISTS mode TEXT",
            ):
                try:
                    conn.execute(ddl)
                except Exception as mig_exc:
                    logger.warning("[duckdb_writer] migration skipped (%s): %s", ddl, mig_exc)

    def insert_event(self, event: dict):
        self.insert_events([event])

    def insert_events(self, events: list[dict]):
        if not events:
            return

        # W-H3: anchor the expected key set on the first event, then validate
        # every subsequent dict against it before building the value list.
        # Using e.values() without this guard silently inserts values into the
        # wrong columns whenever a dict has a different or reordered key set.
        expected_keys = set(events[0].keys())
        col_list = list(events[0].keys())
        cols = ", ".join(col_list)
        placeholders = ", ".join(["?"] * len(col_list))

        rows: list[list] = []
        for i, e in enumerate(events):
            if set(e.keys()) != expected_keys:
                logger.warning(
                    "[duckdb_writer] insert_events: event %d has unexpected keys "
                    "(expected %s, got %s) — skipping to avoid column mismatch",
                    i,
                    sorted(expected_keys),
                    sorted(e.keys()),
                )
                continue
            # Build the row in the same order as col_list, not dict insertion order.
            rows.append([e[k] for k in col_list])

        if not rows:
            return

        with self.get_connection() as conn:
            conn.executemany(
                f"INSERT INTO raw_events ({cols}) VALUES ({placeholders}) ON CONFLICT DO NOTHING",
                rows,
            )

    def insert_session_skills(self, skills: list[dict]):
        if not skills:
            return

        cols = ", ".join(skills[0].keys())
        placeholders = ", ".join(["?"] * len(skills[0]))

        with self.get_connection() as conn:
            conn.executemany(
                f"INSERT INTO raw_session_skills ({cols}) VALUES ({placeholders}) ON CONFLICT DO NOTHING",
                [list(s.values()) for s in skills]
            )

    def insert_session_mcps(self, mcps: list[dict]):
        if not mcps:
            return

        cols = ", ".join(mcps[0].keys())
        placeholders = ", ".join(["?"] * len(mcps[0]))

        with self.get_connection() as conn:
            conn.executemany(
                f"INSERT INTO raw_session_mcps ({cols}) VALUES ({placeholders}) ON CONFLICT DO NOTHING",
                [list(m.values()) for m in mcps]
            )

    def update_file_stats(
        self,
        file_path: str,
        *,
        lines_total: int,
        events_kept: int,
        dropped_known: int,
        dropped_unknown: int,
        parse_errors: int,
        last_error: str | None = None,
        reset: bool = False,
        tenant_id: str = 'local',
    ) -> None:
        """Upsert per-file ingestion counters into ingest_file_stats.

        When reset=True the supplied values become the absolute column values
        (used after a truncation-triggered offset reset so counters reflect the
        current re-read pass, not accumulated history).  When reset=False the
        values are ADDED to whatever is already stored (delta accumulation for
        normal incremental reads).
        """
        if reset:
            with self.get_connection() as conn:
                conn.execute(
                    """
                    INSERT INTO ingest_file_stats
                        (tenant_id, file_path, lines_total, events_kept,
                         dropped_known, dropped_unknown, parse_errors,
                         last_error, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())
                    ON CONFLICT (tenant_id, file_path) DO UPDATE SET
                        lines_total     = excluded.lines_total,
                        events_kept     = excluded.events_kept,
                        dropped_known   = excluded.dropped_known,
                        dropped_unknown = excluded.dropped_unknown,
                        parse_errors    = excluded.parse_errors,
                        last_error      = excluded.last_error,
                        updated_at      = now()
                    """,
                    [tenant_id, file_path, lines_total, events_kept,
                     dropped_known, dropped_unknown, parse_errors, last_error],
                )
        else:
            with self.get_connection() as conn:
                conn.execute(
                    """
                    INSERT INTO ingest_file_stats
                        (tenant_id, file_path, lines_total, events_kept,
                         dropped_known, dropped_unknown, parse_errors,
                         last_error, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())
                    ON CONFLICT (tenant_id, file_path) DO UPDATE SET
                        lines_total     = ingest_file_stats.lines_total     + excluded.lines_total,
                        events_kept     = ingest_file_stats.events_kept     + excluded.events_kept,
                        dropped_known   = ingest_file_stats.dropped_known   + excluded.dropped_known,
                        dropped_unknown = ingest_file_stats.dropped_unknown + excluded.dropped_unknown,
                        parse_errors    = ingest_file_stats.parse_errors    + excluded.parse_errors,
                        last_error      = CASE WHEN excluded.last_error IS NOT NULL
                                               THEN excluded.last_error
                                               ELSE ingest_file_stats.last_error
                                          END,
                        updated_at      = now()
                    """,
                    [tenant_id, file_path, lines_total, events_kept,
                     dropped_known, dropped_unknown, parse_errors, last_error],
                )

    def upsert_session_attributes(
        self,
        session_id: str,
        *,
        title: str | None = None,
        permission_mode: str | None = None,
        mode: str | None = None,
        tenant_id: str = "local",
    ) -> None:
        """Upsert session-level attributes captured from ai-title / permission-mode / mode records.

        COALESCE(excluded.col, session_meta.col) means:
          - a non-NULL incoming value overrides what is stored,
          - a NULL never wipes an existing value.

        Skips the write entirely when all three of title/permission_mode/mode are None
        so no spurious row is created.
        """
        if title is None and permission_mode is None and mode is None:
            return

        with self.get_connection() as conn:
            conn.execute(
                """
                INSERT INTO session_meta (session_id, tenant_id, session_title, permission_mode, mode)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (session_id) DO UPDATE SET
                    session_title   = COALESCE(excluded.session_title,   session_meta.session_title),
                    permission_mode = COALESCE(excluded.permission_mode, session_meta.permission_mode),
                    mode            = COALESCE(excluded.mode,            session_meta.mode)
                """,
                [session_id, tenant_id, title, permission_mode, mode],
            )

    def log_error(self, source: str, file_path: str | None, error: Exception):
        error_message = str(error)
        stack = traceback.format_exc()
        try:
            with self.get_connection() as conn:
                conn.execute(
                    """
                    INSERT INTO watcher_errors (source, file_path, error_message, stack_trace)
                    VALUES (?, ?, ?, ?)
                    """,
                    [source, file_path, error_message, stack],
                )
        except Exception as log_exc:
            print(f"[duckdb_writer] log_error failed to persist: {log_exc}")
