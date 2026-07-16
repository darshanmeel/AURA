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
        assert "ingest_file_stats" in table_names


# ---------------------------------------------------------------------------
# Task 4: update_file_stats — delta accumulation and reset modes
# ---------------------------------------------------------------------------

def test_update_file_stats_insert_and_delta(tmp_path):
    """First call inserts; subsequent calls ADD deltas to the existing row."""
    writer = DuckDBWriter(str(tmp_path / "aura.duckdb"))
    fp = "/logs/project/session/f.jsonl"

    # First call — row does not exist yet; acts as an insert.
    writer.update_file_stats(
        fp,
        lines_total=10, events_kept=8, dropped_known=1, dropped_unknown=0,
        parse_errors=1, last_error="bad line", reset=False,
    )

    with writer.get_connection() as conn:
        row = conn.execute(
            "SELECT lines_total, events_kept, dropped_known, dropped_unknown, "
            "parse_errors, last_error FROM ingest_file_stats WHERE file_path = ?",
            [fp],
        ).fetchone()
    assert row == (10, 8, 1, 0, 1, "bad line")

    # Second call — deltas added to existing values.
    writer.update_file_stats(
        fp,
        lines_total=5, events_kept=4, dropped_known=0, dropped_unknown=1,
        parse_errors=0, last_error=None, reset=False,
    )

    with writer.get_connection() as conn:
        row2 = conn.execute(
            "SELECT lines_total, events_kept, dropped_known, dropped_unknown, "
            "parse_errors, last_error FROM ingest_file_stats WHERE file_path = ?",
            [fp],
        ).fetchone()
    # Numeric columns should be accumulated.
    assert row2[0] == 15   # lines_total
    assert row2[1] == 12   # events_kept
    assert row2[2] == 1    # dropped_known
    assert row2[3] == 1    # dropped_unknown
    assert row2[4] == 1    # parse_errors
    # last_error is NOT cleared when new value is None.
    assert row2[5] == "bad line"


def test_update_file_stats_reset_overwrites(tmp_path):
    """When reset=True the values replace (not accumulate) the existing row."""
    writer = DuckDBWriter(str(tmp_path / "aura.duckdb"))
    fp = "/logs/project/session/g.jsonl"

    writer.update_file_stats(
        fp,
        lines_total=100, events_kept=80, dropped_known=10, dropped_unknown=5,
        parse_errors=5, last_error="old error", reset=False,
    )
    writer.update_file_stats(
        fp,
        lines_total=3, events_kept=2, dropped_known=1, dropped_unknown=0,
        parse_errors=0, last_error=None, reset=True,
    )

    with writer.get_connection() as conn:
        row = conn.execute(
            "SELECT lines_total, events_kept, dropped_known, dropped_unknown, "
            "parse_errors, last_error FROM ingest_file_stats WHERE file_path = ?",
            [fp],
        ).fetchone()
    # Reset must overwrite with the new absolute values.
    assert row[0] == 3     # lines_total
    assert row[1] == 2     # events_kept
    assert row[2] == 1     # dropped_known
    assert row[3] == 0     # dropped_unknown
    assert row[4] == 0     # parse_errors
    assert row[5] is None  # last_error cleared to None on reset


# ---------------------------------------------------------------------------
# Perf fix (2026-07-13): persistent_connection() for the initial-backfill phase
# ---------------------------------------------------------------------------

def test_persistent_connection_reuses_single_connection(tmp_path):
    """While persistent_connection() is active, every get_connection() call
    must yield the SAME underlying connection object (no new connect()).
    Outside the context, get_connection() must go back to opening (and
    closing) a fresh connection per call."""
    writer = DuckDBWriter(str(tmp_path / "aura.duckdb"))

    with writer.get_connection() as conn_a:
        pass
    with writer.get_connection() as conn_b:
        pass
    # Outside persistent mode, each call is a distinct connection object.
    assert conn_a is not conn_b

    with writer.persistent_connection() as pconn:
        with writer.get_connection() as inner1:
            assert inner1 is pconn
        with writer.get_connection() as inner2:
            assert inner2 is pconn
        # A basic query still works against the shared connection.
        assert pconn.execute("SELECT 1").fetchone() == (1,)

    # After the persistent context exits, get_connection() opens fresh
    # connections again (not the now-closed persistent one).
    with writer.get_connection() as conn_c:
        assert conn_c is not pconn
        # The shared connection was closed on context exit; a query against it
        # now should fail.
    import pytest as _pytest
    with _pytest.raises(Exception):
        pconn.execute("SELECT 1")


def test_persistent_connection_writes_are_visible(tmp_path):
    """A write made via get_connection() while persistent_connection() is
    active must be visible both inside and after the context (data isn't lost
    when the shared connection is reused instead of reopened)."""
    writer = DuckDBWriter(str(tmp_path / "aura.duckdb"))
    fp = "/logs/project/session/persist.jsonl"

    with writer.persistent_connection():
        writer.update_file_stats(
            fp,
            lines_total=1, events_kept=1, dropped_known=0, dropped_unknown=0,
            parse_errors=0, last_error=None, reset=False,
        )

    with writer.get_connection() as conn:
        row = conn.execute(
            "SELECT lines_total, events_kept FROM ingest_file_stats WHERE file_path = ?",
            [fp],
        ).fetchone()
    assert row == (1, 1)


def test_update_file_stats_last_error_updated_when_new_error(tmp_path):
    """When a non-None last_error is supplied in a delta call it overwrites
    the previous last_error (most recent error wins)."""
    writer = DuckDBWriter(str(tmp_path / "aura.duckdb"))
    fp = "/logs/session/h.jsonl"

    writer.update_file_stats(
        fp,
        lines_total=5, events_kept=4, dropped_known=0, dropped_unknown=0,
        parse_errors=1, last_error="first error", reset=False,
    )
    writer.update_file_stats(
        fp,
        lines_total=2, events_kept=2, dropped_known=0, dropped_unknown=0,
        parse_errors=0, last_error="second error", reset=False,
    )

    with writer.get_connection() as conn:
        last_error = conn.execute(
            "SELECT last_error FROM ingest_file_stats WHERE file_path = ?", [fp]
        ).fetchone()[0]
    assert last_error == "second error"
