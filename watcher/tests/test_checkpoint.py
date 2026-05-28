from aura_watcher.duckdb_writer import DuckDBWriter
from aura_watcher.checkpoint import CheckpointManager

def test_checkpoint_roundtrip(tmp_path):
    db_path = tmp_path / "test.duckdb"
    writer = DuckDBWriter(str(db_path))
    manager = CheckpointManager(writer)
    
    manager.update_checkpoint("file1.jsonl", 1024, "uuid-1")
    cp = manager.get_checkpoint("file1.jsonl")
    
    assert cp["last_offset"] == 1024
    assert cp["last_line_uuid"] == "uuid-1"
