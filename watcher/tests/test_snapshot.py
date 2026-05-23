import os
import duckdb
from aura_watcher.snapshot import take_snapshot

def test_take_snapshot(tmp_path):
    src = tmp_path / "aura.duckdb"
    # Create valid duckdb file
    duckdb.connect(str(src)).execute("CREATE TABLE t(a INT); INSERT INTO t VALUES (1)").close()
    
    dst = tmp_path / "aura_read.duckdb"
    take_snapshot(str(src), str(dst))
    
    assert dst.exists()
    with duckdb.connect(str(dst)) as conn:
        val = conn.execute("SELECT * FROM t").fetchone()[0]
        assert val == 1
