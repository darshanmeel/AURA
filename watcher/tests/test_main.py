import json
import os
import time
from aura_watcher.duckdb_writer import DuckDBWriter
from aura_watcher.main import process_file
from aura_watcher.adapters.claude import ClaudeAdapter
from aura_watcher.checkpoint import CheckpointManager

def test_ingestion(tmp_path):
    log_dir = tmp_path / "logs" / "session_1"
    log_dir.mkdir(parents=True)
    log_file = log_dir / "log.jsonl"
    
    db_path = tmp_path / "aura.duckdb"
    writer = DuckDBWriter(str(db_path))
    adapter = ClaudeAdapter()
    cp_manager = CheckpointManager(writer)
    
    # Write a dummy line
    log_file.write_text(json.dumps({
        "type": "assistant", "uuid": "u1", "timestamp": "2024-05-23T12:00:00Z",
        "message": {"id": "m1", "usage": {"input_tokens": 10}}
    }) + "\n")
    
    # Run pass
    process_file(str(log_file), writer, adapter, cp_manager)
    
    with writer.get_connection() as conn:
        count = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        assert count == 1
