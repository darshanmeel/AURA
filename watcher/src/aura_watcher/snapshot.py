import os
import shutil

import duckdb


def take_snapshot(src_path: str, dst_path: str):
    """
    Force checkpoint to flush WAL and then atomically copy the DuckDB file
    to dst_path via a .tmp intermediate and os.replace().

    CALLER NOTE: dbt compiles refs into views as fully-qualified
    "<catalog>"."<schema>"."<table>" — e.g. `aura.main.dim_apps`. DuckDB
    derives the catalog name from the filename basename (sans `.duckdb`).
    So views built in `aura.duckdb` will resolve incorrectly if the read DB
    has a different basename (e.g. `aura_read.duckdb` → catalog `aura_read`).
    The caller is responsible for supplying a dst_path whose basename matches
    the source (e.g. `/data/read/aura.duckdb` when src is `aura.duckdb`).
    """
    # Force checkpoint to flush WAL
    with duckdb.connect(src_path) as conn:
        conn.execute("PRAGMA force_checkpoint")

    # Resolve dst_path to an absolute path so dirname is never empty (W-L5).
    dst_path = os.path.abspath(dst_path)
    dst_dir = os.path.dirname(dst_path)
    os.makedirs(dst_dir, exist_ok=True)

    if dst_path == os.path.abspath(src_path):
        # Defensive: never overwrite the source.
        raise ValueError(f"snapshot dst {dst_path} would overwrite src {src_path}")

    tmp_path = dst_path + ".tmp"
    shutil.copy2(src_path, tmp_path)
    os.replace(tmp_path, dst_path)
