import os
import duckdb
import pytest
from aura_watcher.snapshot import take_snapshot


# ---------------------------------------------------------------------------
# W-L6: canonical dst behavior — same basename, different directory
# ---------------------------------------------------------------------------

def test_take_snapshot(tmp_path):
    """Snapshot must copy the source DB to a destination in a DIFFERENT
    directory but with the SAME basename so that dbt-compiled view refs
    (e.g. `aura.main.dim_apps`) resolve correctly in the read DB.

    Before fix the test used `aura_read.duckdb` (different basename) in the
    same directory; now it uses `read_db/aura.duckdb` (same basename,
    different directory) to exercise the os.replace() rename path.
    """
    src = tmp_path / "aura.duckdb"
    # Create a valid DuckDB file with some data.
    with duckdb.connect(str(src)) as conn:
        conn.execute("CREATE TABLE t(a INT); INSERT INTO t VALUES (1)")

    # Destination: same basename as source, in a subdirectory.
    read_dir = tmp_path / "read_db"
    dst = read_dir / "aura.duckdb"

    # read_dir does not exist yet — take_snapshot must create it.
    assert not read_dir.exists()

    take_snapshot(str(src), str(dst))

    # Directory was created.
    assert read_dir.exists()
    # Destination file exists.
    assert dst.exists()
    # No stray .tmp file left behind.
    assert not (read_dir / "aura.duckdb.tmp").exists()
    # Data is intact and readable.
    with duckdb.connect(str(dst)) as conn:
        val = conn.execute("SELECT * FROM t").fetchone()[0]
        assert val == 1


def test_take_snapshot_overwrites_existing_dst(tmp_path):
    """A second snapshot call must replace a pre-existing dst atomically via
    os.replace(), not fail or leave a partial file."""
    src = tmp_path / "aura.duckdb"
    with duckdb.connect(str(src)) as conn:
        conn.execute("CREATE TABLE t(a INT); INSERT INTO t VALUES (1)")

    read_dir = tmp_path / "read_db"
    dst = read_dir / "aura.duckdb"

    # First snapshot.
    take_snapshot(str(src), str(dst))
    assert dst.exists()

    # Update source with new data.
    with duckdb.connect(str(src)) as conn:
        conn.execute("INSERT INTO t VALUES (99)")

    # Second snapshot should overwrite cleanly.
    take_snapshot(str(src), str(dst))

    with duckdb.connect(str(dst)) as conn:
        vals = sorted(r[0] for r in conn.execute("SELECT a FROM t").fetchall())
    assert vals == [1, 99]


def test_take_snapshot_raises_if_src_equals_dst(tmp_path):
    """Overwriting the source DB must raise ValueError (defensive guard in
    take_snapshot to prevent data corruption)."""
    src = tmp_path / "aura.duckdb"
    with duckdb.connect(str(src)) as conn:
        conn.execute("CREATE TABLE t(a INT); INSERT INTO t VALUES (1)")

    with pytest.raises(ValueError, match="would overwrite src"):
        take_snapshot(str(src), str(src))


def test_take_snapshot_tmp_cleaned_up_on_success(tmp_path):
    """The .tmp intermediate file must not exist after a successful snapshot."""
    src = tmp_path / "aura.duckdb"
    with duckdb.connect(str(src)) as conn:
        conn.execute("CREATE TABLE t(a INT)")

    read_dir = tmp_path / "read_db"
    dst = read_dir / "aura.duckdb"
    take_snapshot(str(src), str(dst))

    assert not os.path.exists(str(dst) + ".tmp")
