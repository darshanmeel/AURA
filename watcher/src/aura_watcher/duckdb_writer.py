import duckdb
import traceback
from contextlib import contextmanager

class DuckDBWriter:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._init_db()

    @contextmanager
    def get_connection(self):
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
                CREATE TABLE IF NOT EXISTS watcher_errors (
                    ts            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    source        VARCHAR,
                    file_path     VARCHAR,
                    error_message VARCHAR,
                    stack_trace   VARCHAR
                );
                CREATE INDEX IF NOT EXISTS idx_watcher_errors_ts ON watcher_errors(ts);
            """)

    def insert_event(self, event: dict):
        self.insert_events([event])

    def insert_events(self, events: list[dict]):
        if not events:
            return
        
        # Use the keys from the first event as columns
        cols = ", ".join(events[0].keys())
        placeholders = ", ".join(["?"] * len(events[0]))
        
        with self.get_connection() as conn:
            # Efficient batch insert
            conn.executemany(
                f"INSERT INTO raw_events ({cols}) VALUES ({placeholders}) ON CONFLICT DO NOTHING",
                [list(e.values()) for e in events]
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
