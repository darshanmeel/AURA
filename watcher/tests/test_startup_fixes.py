"""Tests for the 2026-07-16 three-part watcher startup/self-healing fix
package:

  TMP1 — purge orphaned DuckDB spill files (``{db_path}.tmp``) at startup.
  FR1  — `dbt source freshness` moved to the top of the locked dbt cycle and
         skipped until the initial backfill has completed.
  SW1  — a periodic self-healing ingest sweep that re-discovers and
         re-ingests files the live watcher missed, with a rate-limited
         liveness alert.

Covers:
  (a) purge_duckdb_spill_dir as a pure filesystem unit test — including
      tolerance of a file that can't be removed.
  (b) dbt_worker's freshness gating — skipped while initial_backfill_done is
      unset, invoked FIRST (before seed) once it is set.
  (c) filter_files_with_new_bytes selection logic, plus an end-to-end
      sweep_worker tick that re-ingests only the file with unread bytes.
  (d) sweep_worker's 2-consecutive-sweep liveness alert rate limiting.
"""
import json
import subprocess
import threading

import pytest

import aura_watcher.main as main_module
from aura_watcher.main import (
    purge_duckdb_spill_dir,
    filter_files_with_new_bytes,
    process_file,
)
from aura_watcher.duckdb_writer import DuckDBWriter
from aura_watcher.checkpoint import CheckpointManager
from aura_watcher.adapters.claude import ClaudeAdapter


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


class _StopLoop(Exception):
    """Sentinel raised by a monkeypatched time.sleep() to escape an
    otherwise-infinite worker `while True:` loop after a controlled number
    of iterations, without needing a background thread."""


@pytest.fixture(autouse=True)
def _reset_initial_backfill_done():
    """initial_backfill_done is a module-level (process-global) Event read by
    both dbt_worker and sweep_worker. Force it to a known-cleared state
    before AND after every test in this file so tests never leak state into
    each other (or into other test files sharing the same process)."""
    main_module.initial_backfill_done.clear()
    yield
    main_module.initial_backfill_done.clear()


# ---------------------------------------------------------------------------
# (a) TMP1 — purge_duckdb_spill_dir: pure filesystem unit tests
# ---------------------------------------------------------------------------

def test_purge_spill_dir_noop_when_dir_missing(tmp_path):
    """First-ever run (or a clean shutdown that left nothing behind): the
    ``{db_path}.tmp`` directory doesn't exist at all. Must be a true no-op —
    no exception, (0, 0) returned."""
    db_path = str(tmp_path / "aura.duckdb")
    files_purged, bytes_purged = purge_duckdb_spill_dir(db_path)
    assert (files_purged, bytes_purged) == (0, 0)


def test_purge_spill_dir_removes_files_and_empty_subdirs(tmp_path):
    """Normal case: a spill dir with a top-level file and a nested
    subdirectory's file, both removed; the now-empty subdirectory is also
    removed; the spill dir ITSELF (only its contents) survives."""
    db_path = str(tmp_path / "aura.duckdb")
    spill_dir = tmp_path / "aura.duckdb.tmp"
    spill_dir.mkdir()
    top_file = spill_dir / "block_a.tmp"
    top_file.write_bytes(b"x" * 100)
    sub_dir = spill_dir / "sub"
    sub_dir.mkdir()
    nested_file = sub_dir / "block_b.tmp"
    nested_file.write_bytes(b"y" * 50)

    files_purged, bytes_purged = purge_duckdb_spill_dir(db_path)

    assert files_purged == 2
    assert bytes_purged == 150
    assert not top_file.exists()
    assert not nested_file.exists()
    assert not sub_dir.exists()   # emptied, so best-effort rmdir succeeded
    assert spill_dir.exists()     # CONTENTS purged, not the dir itself


def test_purge_spill_dir_tolerates_one_undeletable_file(tmp_path, monkeypatch):
    """One file that can't be removed (simulated: still locked / permission
    denied) must never abort the purge or raise — the other files are still
    removed, and the stuck file survives untouched."""
    db_path = str(tmp_path / "aura.duckdb")
    spill_dir = tmp_path / "aura.duckdb.tmp"
    spill_dir.mkdir()
    removable_a = spill_dir / "removable_a.tmp"
    removable_a.write_bytes(b"a" * 10)
    stuck = spill_dir / "stuck.tmp"
    stuck.write_bytes(b"b" * 20)
    sub_dir = spill_dir / "sub"
    sub_dir.mkdir()
    removable_b = sub_dir / "removable_b.tmp"
    removable_b.write_bytes(b"c" * 5)

    real_remove = main_module.os.remove
    stuck_path = str(stuck)

    def fake_remove(path):
        if str(path) == stuck_path:
            raise OSError("simulated: file still locked by another process")
        real_remove(path)

    monkeypatch.setattr(main_module.os, "remove", fake_remove)

    # Must not raise.
    files_purged, bytes_purged = purge_duckdb_spill_dir(db_path)

    # Only the two removable files were actually deleted.
    assert files_purged == 2
    assert bytes_purged == 15
    assert not removable_a.exists()
    assert not removable_b.exists()
    # The stuck file survives, untouched.
    assert stuck.exists()
    assert stuck.read_bytes() == b"b" * 20
    # sub_dir became empty (removable_b removed) so it WAS rmdir'd.
    assert not sub_dir.exists()
    # spill_dir itself still exists (still holds the stuck file).
    assert spill_dir.exists()


# ---------------------------------------------------------------------------
# (b) FR1 — dbt_worker freshness gating
# ---------------------------------------------------------------------------

def _run_one_dbt_cycle(monkeypatch, writer):
    """Run dbt_worker() for EXACTLY one loop iteration by making the
    end-of-loop time.sleep() raise _StopLoop, and return the ordered list of
    subprocess.run() argv lists that were invoked during that iteration.

    Also neuters os.makedirs so dbt_worker's unconditional
    os.makedirs("/data/artifacts", exist_ok=True) never touches the real
    filesystem outside tmp_path during a test.
    """
    calls: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    def fake_sleep(_secs):
        raise _StopLoop()

    monkeypatch.setattr(main_module.subprocess, "run", fake_run)
    monkeypatch.setattr(main_module.os, "makedirs", lambda *a, **k: None)
    monkeypatch.setattr(main_module.time, "sleep", fake_sleep)

    with pytest.raises(_StopLoop):
        main_module.dbt_worker(1, writer)

    return calls


def test_dbt_worker_skips_freshness_when_backfill_incomplete(tmp_path, monkeypatch):
    """initial_backfill_done unset (e.g. mid-startup, before the initial
    backfill has finished): `dbt source freshness` must NOT be invoked at
    all this cycle."""
    writer, _cp_manager = _make_writer_and_deps(tmp_path)
    assert not main_module.initial_backfill_done.is_set()

    calls = _run_one_dbt_cycle(monkeypatch, writer)

    freshness_calls = [c for c in calls if c[:3] == ["dbt", "source", "freshness"]]
    assert freshness_calls == []
    # seed/run/test still ran (unchanged behavior otherwise).
    assert calls[0][:2] == ["dbt", "seed"]
    assert calls[1][:2] == ["dbt", "run"]
    assert calls[2][:2] == ["dbt", "test"]


def test_dbt_worker_runs_freshness_first_when_backfill_complete(tmp_path, monkeypatch):
    """initial_backfill_done set: `dbt source freshness` must be the FIRST
    subprocess invoked this cycle — before seed, run, and test."""
    writer, _cp_manager = _make_writer_and_deps(tmp_path)
    main_module.initial_backfill_done.set()

    calls = _run_one_dbt_cycle(monkeypatch, writer)

    assert calls[0] == ["dbt", "source", "freshness", "--profiles-dir", ".", "--no-partial-parse"]
    assert calls[1][:2] == ["dbt", "seed"]
    assert calls[2][:2] == ["dbt", "run"]
    assert calls[3][:2] == ["dbt", "test"]
    # Exactly one freshness invocation this cycle (not also re-run later).
    freshness_calls = [c for c in calls if c[:3] == ["dbt", "source", "freshness"]]
    assert len(freshness_calls) == 1


# ---------------------------------------------------------------------------
# (c) SW1 — filter_files_with_new_bytes selection logic
# ---------------------------------------------------------------------------

def test_filter_files_with_new_bytes_identifies_new_and_skips_caught_up(tmp_path):
    f_new = tmp_path / "new.jsonl"                 # bytes beyond its checkpoint
    f_caught_up = tmp_path / "caught_up.jsonl"      # size == checkpoint offset
    f_unchecked = tmp_path / "unchecked.jsonl"      # no checkpoint row at all
    f_new.write_bytes(b"x" * 100)
    f_caught_up.write_bytes(b"y" * 50)
    f_unchecked.write_bytes(b"z" * 10)

    cp_offsets = {
        str(f_new): 40,        # 40 < 100 -> has new bytes
        str(f_caught_up): 50,  # 50 == 50 -> fully caught up, no new bytes
        # f_unchecked intentionally absent -> implicit offset 0 -> has new bytes
    }

    result = filter_files_with_new_bytes(
        [str(f_new), str(f_caught_up), str(f_unchecked)], cp_offsets
    )

    assert set(result) == {str(f_new), str(f_unchecked)}
    assert str(f_caught_up) not in result


def test_filter_files_with_new_bytes_drops_vanished_file_without_raising(tmp_path):
    vanished = str(tmp_path / "gone.jsonl")  # never created on disk
    present = tmp_path / "present.jsonl"
    present.write_bytes(b"abc")

    result = filter_files_with_new_bytes([vanished, str(present)], {})

    assert vanished not in result
    assert str(present) in result


def test_sweep_worker_tick_reingests_only_file_with_new_bytes(tmp_path, monkeypatch):
    """End-to-end: one real sweep_worker tick must re-ingest a file the live
    watcher "missed" an append to, and must NOT reprocess (or duplicate) a
    file whose checkpoint is already fully caught up."""
    writer, cp_manager = _make_writer_and_deps(tmp_path)
    log_dir = tmp_path / "logs" / "proj"
    log_dir.mkdir(parents=True)

    stale_file = log_dir / "stale.jsonl"
    caught_up_file = log_dir / "caught_up.jsonl"

    line1 = _make_line("uuid-stale-1")
    line2 = _make_line("uuid-stale-2")
    stale_file.write_bytes(line1)

    caught_up_file.write_bytes(_make_line("uuid-caughtup-1"))

    adapter = ClaudeAdapter()
    process_file(str(stale_file), writer, adapter, cp_manager)       # ingests line1 only
    process_file(str(caught_up_file), writer, adapter, cp_manager)   # fully ingested

    # Simulate the live watcher missing an append to stale_file.
    with open(stale_file, "ab") as fh:
        fh.write(line2)

    with writer.get_connection() as conn:
        count_before = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
    assert count_before == 2

    main_module.initial_backfill_done.set()
    lock = threading.Lock()

    sleep_calls = {"n": 0}

    def fake_sleep(_secs):
        sleep_calls["n"] += 1
        if sleep_calls["n"] > 1:
            raise _StopLoop()

    monkeypatch.setattr(main_module.time, "sleep", fake_sleep)

    with pytest.raises(_StopLoop):
        main_module.sweep_worker(writer, cp_manager, [str(tmp_path / "logs")], lock, 1)

    with writer.get_connection() as conn:
        count_after = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        uuids = {r[0] for r in conn.execute("SELECT uuid FROM raw_events").fetchall()}

    # Only the missed line landed -- the caught-up file was not reprocessed
    # (no duplicate row for uuid-caughtup-1, checked via the exact count).
    assert count_after == 3
    assert uuids == {"uuid-stale-1", "uuid-stale-2", "uuid-caughtup-1"}


# ---------------------------------------------------------------------------
# (d) SW1 — 2-consecutive-sweep liveness alert rate limiting
# ---------------------------------------------------------------------------

def _run_sweep_ticks(monkeypatch, writer, cp_manager, hit_sequence):
    """Run sweep_worker for exactly len(hit_sequence) ticks. hit_sequence[i]
    is the `to_process` list filter_files_with_new_bytes should yield on
    tick i+1 (an empty list == a clean sweep with nothing to catch up on).

    filter_files_with_new_bytes and list_backfill_files are both stubbed so
    the streak/alert bookkeeping inside sweep_worker is exercised in
    isolation from real filesystem scanning and real checkpoint state.
    """
    call_idx = {"n": 0}

    def fake_filter(_files, _cp_offsets):
        i = call_idx["n"]
        call_idx["n"] += 1
        return list(hit_sequence[i]) if i < len(hit_sequence) else []

    sleep_calls = {"n": 0}

    def fake_sleep(_secs):
        sleep_calls["n"] += 1
        if sleep_calls["n"] > len(hit_sequence):
            raise _StopLoop()

    monkeypatch.setattr(main_module, "filter_files_with_new_bytes", fake_filter)
    monkeypatch.setattr(main_module, "list_backfill_files", lambda scan_dirs: [])
    monkeypatch.setattr(main_module.time, "sleep", fake_sleep)

    main_module.initial_backfill_done.set()
    lock = threading.Lock()
    with pytest.raises(_StopLoop):
        main_module.sweep_worker(writer, cp_manager, ["/nonexistent"], lock, 1)


def _liveness_error_count(writer) -> int:
    with writer.get_connection() as conn:
        return conn.execute(
            "SELECT count(*) FROM watcher_errors WHERE source = 'ingest_liveness'"
        ).fetchone()[0]


def test_sweep_liveness_streak_of_one_does_not_alert(tmp_path, monkeypatch):
    writer, cp_manager = _make_writer_and_deps(tmp_path)
    _run_sweep_ticks(monkeypatch, writer, cp_manager, hit_sequence=[["fileA"]])
    assert _liveness_error_count(writer) == 0


def test_sweep_liveness_streak_of_two_alerts_exactly_once(tmp_path, monkeypatch):
    writer, cp_manager = _make_writer_and_deps(tmp_path)
    _run_sweep_ticks(monkeypatch, writer, cp_manager, hit_sequence=[["fileA"], ["fileA"]])
    assert _liveness_error_count(writer) == 1


def test_sweep_liveness_streak_continuing_to_four_still_only_one_row(tmp_path, monkeypatch):
    writer, cp_manager = _make_writer_and_deps(tmp_path)
    _run_sweep_ticks(
        monkeypatch, writer, cp_manager,
        hit_sequence=[["fileA"], ["fileA"], ["fileA"], ["fileA"]],
    )
    assert _liveness_error_count(writer) == 1


def test_sweep_liveness_clean_sweep_resets_streak_for_later_realert(tmp_path, monkeypatch):
    """hit, hit (alert #1), clean (reset), hit, hit (alert #2) -> exactly two
    rows total, proving the streak really resets rather than being
    permanently silenced after the first episode."""
    writer, cp_manager = _make_writer_and_deps(tmp_path)
    _run_sweep_ticks(
        monkeypatch, writer, cp_manager,
        hit_sequence=[["fileA"], ["fileA"], [], ["fileA"], ["fileA"]],
    )
    assert _liveness_error_count(writer) == 2
