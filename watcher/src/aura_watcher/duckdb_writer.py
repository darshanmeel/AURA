import duckdb
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
            """)

    def insert_event(self, event: dict):
        cols = ", ".join(event.keys())
        placeholders = ", ".join(["?"] * len(event))
        with self.get_connection() as conn:
            conn.execute(f"INSERT OR IGNORE INTO raw_events ({cols}) VALUES ({placeholders})", list(event.values()))
