import os
import shutil
import duckdb

def take_snapshot(src_path: str, dst_path: str):
    """
    Force checkpoint to flush WAL and then atomically copy the DuckDB file.
    """
    # Force checkpoint to flush WAL
    with duckdb.connect(src_path) as conn:
        conn.execute("PRAGMA force_checkpoint")
    
    # Atomic copy
    tmp_path = dst_path + ".tmp"
    shutil.copy2(src_path, tmp_path)
    os.replace(tmp_path, dst_path)
