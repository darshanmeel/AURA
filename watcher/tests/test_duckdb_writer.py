import os
import duckdb
from aura_watcher.duckdb_writer import DuckDBWriter

def test_init_creates_tables(tmp_path):
    db_path = tmp_path / "test_aura.duckdb"
    writer = DuckDBWriter(str(db_path))
    
    with writer.get_connection() as conn:
        tables = conn.execute("SHOW TABLES").fetchall()
        table_names = [t[0] for t in tables]
        assert "raw_events" in table_names
        assert "ingest_checkpoints" in table_names
