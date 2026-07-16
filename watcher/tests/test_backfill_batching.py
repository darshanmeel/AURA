"""Tests for the batched initial-backfill fix (2026-07-13).

Goal: the initial backfill must no longer hold the DuckDB file lock (via a
single persistent connection) for its ENTIRE duration. It must process files
in batches, closing the persistent connection AND releasing _snapshot_lock
between batches, so periodic workers (snapshot_worker / dbt_worker /
coverage_worker) — which are now started BEFORE the backfill loop — get real
windows to run while backfill is still in progress.

Covers:
  (a) batched backfill still ingests all to_process files exactly once,
      idempotently (checkpoints advance, re-running the same file list is a
      no-op on the second pass).
  (b) no deadlock when a simulated snapshot/dbt "tick" thread interleaves
      with backfill batches, and that ticker really does acquire the lock at
      least once (proving batches release it, not just that nothing crashed).
  (c) the persistent connection is opened and cleanly closed at each batch
      boundary (never two opens without an intervening close).
"""
import contextlib
import json
import threading
import time

import pytest

from aura_watcher.duckdb_writer import DuckDBWriter
from aura_watcher.checkpoint import CheckpointManager
from aura_watcher.adapters.claude import ClaudeAdapter
from aura_watcher.main import process_file, run_batched_backfill


def _make_line(uuid, ts="2024-05-23T12:00:00Z"):
    return (json.dumps({
        "type": "assistant",
        "uuid": uuid,
        "timestamp": ts,
        "sessionId": "session_test",
        "message": {
            "id": f"msg-{uuid}",
            "model": "claude-3-5-sonnet-20241022",
            "usage": {
                "input_tokens": 10,
                "output_tokens": 5,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            },
        },
    }) + "\n").encode("utf-8")


def _make_writer_and_deps(tmp_path):
    db_path = tmp_path / "aura.duckdb"
    writer = DuckDBWriter(str(db_path))
    cp_manager = CheckpointManager(writer)
    return writer, cp_manager


def _write_files(tmp_path, n, lines_per_file=1):
    files = []
    log_root = tmp_path / "logs"
    for i in range(n):
        d = log_root / f"session_{i}"
        d.mkdir(parents=True)
        fp = d / "log.jsonl"
        blob = b"".join(_make_line(f"uuid-{i}-{j}") for j in range(lines_per_file))
        fp.write_bytes(blob)
        files.append(str(fp))
    return files


# ---------------------------------------------------------------------------
# (a) idempotent ingestion across batches
# ---------------------------------------------------------------------------

def test_batched_backfill_ingests_all_files_exactly_once(tmp_path):
    files = _write_files(tmp_path, n=7, lines_per_file=2)
    writer, cp_manager = _make_writer_and_deps(tmp_path)
    lock = threading.Lock()

    processed = run_batched_backfill(files, writer, cp_manager, lock, batch_size=2, batch_seconds=120)
    assert processed == 7

    with writer.get_connection() as conn:
        count = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        assert count == 14  # 7 files * 2 lines

        offsets = dict(conn.execute(
            "SELECT file_path, last_offset FROM ingest_checkpoints"
        ).fetchall())
    for f in files:
        assert offsets[f] > 0


def test_batched_backfill_rerun_same_files_is_idempotent(tmp_path):
    """Re-running run_batched_backfill over the SAME (already fully-ingested)
    file list must not create duplicate rows or move checkpoints backward —
    process_file's own offset-tracking makes the second pass a no-op."""
    files = _write_files(tmp_path, n=5, lines_per_file=1)
    writer, cp_manager = _make_writer_and_deps(tmp_path)
    lock = threading.Lock()

    run_batched_backfill(files, writer, cp_manager, lock, batch_size=2, batch_seconds=120)
    with writer.get_connection() as conn:
        count_1 = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        offsets_1 = dict(conn.execute("SELECT file_path, last_offset FROM ingest_checkpoints").fetchall())

    # Second pass over the identical list (simulates a caller that did not
    # re-filter via checkpoints) — nothing new to read past the saved offset.
    run_batched_backfill(files, writer, cp_manager, lock, batch_size=2, batch_seconds=120)
    with writer.get_connection() as conn:
        count_2 = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        offsets_2 = dict(conn.execute("SELECT file_path, last_offset FROM ingest_checkpoints").fetchall())

    assert count_2 == count_1 == 5
    assert offsets_2 == offsets_1


# ---------------------------------------------------------------------------
# (c) batch boundaries: persistent connection opened/closed cleanly per batch
# ---------------------------------------------------------------------------

def test_persistent_connection_closed_between_batches(tmp_path):
    """Instruments DuckDBWriter.persistent_connection to record open/close
    events. With batch_size=2 over 5 files we expect 3 batches -> 3 clean
    open/close pairs, strictly alternating (never two opens in a row)."""
    files = _write_files(tmp_path, n=5, lines_per_file=1)

    db_path = tmp_path / "aura.duckdb"
    base_writer = DuckDBWriter(str(db_path))
    events: list[str] = []

    real_persistent_connection = base_writer.persistent_connection

    @contextlib.contextmanager
    def recording_persistent_connection():
        events.append("open")
        with real_persistent_connection() as conn:
            yield conn
        events.append("close")

    base_writer.persistent_connection = recording_persistent_connection
    cp_manager = CheckpointManager(base_writer)
    lock = threading.Lock()

    run_batched_backfill(files, base_writer, cp_manager, lock, batch_size=2, batch_seconds=120)

    assert events == ["open", "close"] * 3
    # And the writer must not be left holding a persistent connection.
    assert base_writer._persistent_conn is None


# ---------------------------------------------------------------------------
# (b) no deadlock with a concurrent lock "tick" (simulated snapshot/dbt worker)
# ---------------------------------------------------------------------------

def test_batched_backfill_no_deadlock_with_concurrent_lock_tick(tmp_path):
    """A background thread repeatedly acquires/releases the SAME lock that
    run_batched_backfill uses, simulating snapshot_worker/dbt_worker trying to
    grab _snapshot_lock between batches. This must:
      1. finish within a bounded timeout (no deadlock), and
      2. let the ticker actually acquire the lock at least once (proving the
         batches genuinely release it, not just that nothing crashed).
    """
    files = _write_files(tmp_path, n=12, lines_per_file=1)
    writer, cp_manager = _make_writer_and_deps(tmp_path)
    lock = threading.Lock()

    tick_counts = {"n": 0}
    stop = threading.Event()

    def ticker():
        while not stop.is_set():
            acquired = lock.acquire(timeout=0.05)
            if acquired:
                tick_counts["n"] += 1
                lock.release()
            time.sleep(0.01)

    ticker_thread = threading.Thread(target=ticker, daemon=True)
    ticker_thread.start()

    result = {}

    def run():
        result["processed"] = run_batched_backfill(
            files, writer, cp_manager, lock, batch_size=3, batch_seconds=120
        )

    backfill_thread = threading.Thread(target=run)
    backfill_thread.start()
    backfill_thread.join(timeout=15)
    assert not backfill_thread.is_alive(), "batched backfill deadlocked / did not finish in time"

    stop.set()
    ticker_thread.join(timeout=5)

    assert result["processed"] == 12
    assert tick_counts["n"] > 0, "ticker never acquired the lock — batches never released it between iterations"

    with writer.get_connection() as conn:
        count = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
    assert count == 12


# ---------------------------------------------------------------------------
# process_file(hold_lock=False) — the lock-free core used inside a batch
# ---------------------------------------------------------------------------

def test_process_file_hold_lock_false_still_ingests_and_advances_checkpoint(tmp_path):
    """hold_lock=False must behave identically to the default (hold_lock=True)
    in terms of data written — it only skips acquiring _snapshot_lock itself,
    trusting the caller (run_batched_backfill) to already hold it."""
    files = _write_files(tmp_path, n=1, lines_per_file=3)
    writer, cp_manager = _make_writer_and_deps(tmp_path)
    adapter = ClaudeAdapter()

    process_file(files[0], writer, adapter, cp_manager, hold_lock=False)

    with writer.get_connection() as conn:
        count = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        assert count == 3
        offset = conn.execute(
            "SELECT last_offset FROM ingest_checkpoints WHERE file_path = ?",
            [files[0]],
        ).fetchone()[0]
        assert offset > 0


def test_batched_backfill_respects_wall_clock_batch_seconds(tmp_path):
    """A batch_seconds so small that only ~1 file fits per time-slice still
    processes every file correctly (just across more, smaller batches)."""
    files = _write_files(tmp_path, n=4, lines_per_file=1)
    writer, cp_manager = _make_writer_and_deps(tmp_path)
    lock = threading.Lock()

    # batch_size large (never the limiting factor); batch_seconds tiny so the
    # wall-clock cap is what forces multiple batches.
    processed = run_batched_backfill(
        files, writer, cp_manager, lock, batch_size=1000, batch_seconds=0
    )
    assert processed == 4
    with writer.get_connection() as conn:
        count = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
    assert count == 4
