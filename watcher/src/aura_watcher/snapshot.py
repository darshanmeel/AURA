import os
import shutil
import duckdb

def take_snapshot(src_path: str, dst_path: str):
    """
    Force checkpoint to flush WAL and then atomically copy the DuckDB file.

    IMPORTANT: dbt compiles refs into views as fully-qualified
    "<catalog>"."<schema>"."<table>" — e.g. `aura.main.dim_apps`. DuckDB
    derives the catalog name from the filename basename (sans `.duckdb`).
    So views built in `aura.duckdb` will fail in a destination named
    `aura_read.duckdb` (catalog `aura_read`).

    To keep view bodies portable, the destination filename's basename
    (sans extension) MUST equal the source's. We accept whatever path the
    caller supplies, but write the bytes into a sibling file whose name
    matches the source. The caller-supplied `dst_path` is kept as a
    convenience symlink/copy if needed by other tooling, but the
    canonical read DB lives at `<dst_dir>/<src_basename>`.
    """
    # Force checkpoint to flush WAL
    with duckdb.connect(src_path) as conn:
        conn.execute("PRAGMA force_checkpoint")

    src_base = os.path.basename(src_path)
    dst_dir  = os.path.dirname(dst_path) or "."
    os.makedirs(dst_dir, exist_ok=True)

    canonical_dst = os.path.join(dst_dir, src_base) \
        if os.path.basename(dst_path) != src_base else dst_path

    if os.path.abspath(canonical_dst) == os.path.abspath(src_path):
        # Defensive: never overwrite the source.
        raise ValueError(f"snapshot dst {canonical_dst} would overwrite src {src_path}")

    tmp_path = canonical_dst + ".tmp"
    shutil.copy2(src_path, tmp_path)
    os.replace(tmp_path, canonical_dst)
