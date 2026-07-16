"""Tests for watcher/src/aura_watcher/coverage.py"""
import json
import os
import pytest
from aura_watcher.duckdb_writer import DuckDBWriter
from aura_watcher.checkpoint import CheckpointManager
from aura_watcher.coverage import write_coverage
from datetime import datetime, timezone


def _make_writer(tmp_path):
    return DuckDBWriter(str(tmp_path / "aura.duckdb"))


def _seed_checkpoint(writer, file_path, offset):
    cp = CheckpointManager(writer)
    cp.update_checkpoint(file_path, offset, None)


def _seed_file_stats(writer, file_path, *, lines_total=0, events_kept=0,
                     dropped_known=0, dropped_unknown=0, parse_errors=0,
                     last_error=None):
    writer.update_file_stats(
        file_path,
        lines_total=lines_total,
        events_kept=events_kept,
        dropped_known=dropped_known,
        dropped_unknown=dropped_unknown,
        parse_errors=parse_errors,
        last_error=last_error,
        reset=True,
    )


# ---------------------------------------------------------------------------
# Basic shape & status classification
# ---------------------------------------------------------------------------

def test_write_coverage_creates_latest_and_dated_json(tmp_path):
    """write_coverage must create both latest.json and a dated file."""
    writer = _make_writer(tmp_path)
    artifacts_dir = str(tmp_path / "artifacts")

    # One file, fully ingested.
    fp = str(tmp_path / "session" / "f.jsonl")
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, "w") as fh:
        fh.write('{"x":1}\n')
    size = os.path.getsize(fp)
    _seed_checkpoint(writer, fp, size)

    write_coverage(writer, [fp], artifacts_dir)

    cov_dir = os.path.join(artifacts_dir, "ingest_coverage")
    assert os.path.exists(os.path.join(cov_dir, "latest.json"))
    # There must be exactly one dated file (today's date).
    dated = [f for f in os.listdir(cov_dir) if f != "latest.json" and f.endswith(".json")]
    assert len(dated) == 1


def test_write_coverage_summary_counts(tmp_path):
    """summary counts must reflect full/partial/unprocessed correctly."""
    writer = _make_writer(tmp_path)
    artifacts_dir = str(tmp_path / "artifacts")

    base = tmp_path / "logs"
    base.mkdir()

    # full file
    fp_full = str(base / "full.jsonl")
    with open(fp_full, "w") as f:
        f.write('{"x":1}\n')
    size_full = os.path.getsize(fp_full)
    _seed_checkpoint(writer, fp_full, size_full)
    _seed_file_stats(writer, fp_full, lines_total=1, events_kept=1)

    # partial file
    fp_partial = str(base / "partial.jsonl")
    with open(fp_partial, "w") as f:
        f.write('{"x":1}\n{"x":2}\n')
    _seed_checkpoint(writer, fp_partial, 10)  # offset < size
    _seed_file_stats(writer, fp_partial, lines_total=1, events_kept=1, dropped_known=0)

    # unprocessed file (no checkpoint)
    fp_unproc = str(base / "unproc.jsonl")
    with open(fp_unproc, "w") as f:
        f.write('{"x":3}\n')

    write_coverage(writer, [fp_full, fp_partial, fp_unproc], artifacts_dir)

    latest = json.loads(open(os.path.join(artifacts_dir, "ingest_coverage", "latest.json")).read())
    s = latest["summary"]

    assert s["files_total"] == 3
    assert s["files_full"] == 1
    assert s["files_partial"] == 1
    assert s["files_unprocessed"] == 1
    assert s["bytes_total"] == os.path.getsize(fp_full) + os.path.getsize(fp_partial) + os.path.getsize(fp_unproc)
    assert s["events_kept"] == 2  # 1 from full + 1 from partial


def test_write_coverage_files_array_excludes_full(tmp_path):
    """The files[] array must contain ONLY partial and unprocessed entries.
    Full files must be in the summary counts but not in files[]."""
    writer = _make_writer(tmp_path)
    artifacts_dir = str(tmp_path / "artifacts")

    base = tmp_path / "logs"
    base.mkdir()

    fp_full = str(base / "done.jsonl")
    with open(fp_full, "w") as f:
        f.write('{"x":1}\n')
    _seed_checkpoint(writer, fp_full, os.path.getsize(fp_full))

    fp_partial = str(base / "wip.jsonl")
    with open(fp_partial, "w") as f:
        f.write('{"x":1}\n{"x":2}\n')
    _seed_checkpoint(writer, fp_partial, 5)

    write_coverage(writer, [fp_full, fp_partial], artifacts_dir)

    latest = json.loads(open(os.path.join(artifacts_dir, "ingest_coverage", "latest.json")).read())
    paths_in_files = [e["path"] for e in latest["files"]]

    assert fp_full not in paths_in_files, "Full files must not appear in files[]"
    assert fp_partial in paths_in_files, "Partial file must appear in files[]"


def test_write_coverage_files_sorted_by_bytes_remaining_desc(tmp_path):
    """files[] must be sorted by bytes_remaining descending (biggest gap first)."""
    writer = _make_writer(tmp_path)
    artifacts_dir = str(tmp_path / "artifacts")

    base = tmp_path / "logs"
    base.mkdir()

    files = []
    for name, content in [
        ("small.jsonl", '{"x":1}\n' * 5),
        ("large.jsonl", '{"x":1}\n' * 50),
        ("medium.jsonl", '{"x":1}\n' * 20),
    ]:
        fp = str(base / name)
        with open(fp, "w") as f:
            f.write(content)
        # No checkpoint → unprocessed, bytes_remaining = full size.
        files.append(fp)

    write_coverage(writer, files, artifacts_dir)

    latest = json.loads(open(os.path.join(artifacts_dir, "ingest_coverage", "latest.json")).read())
    remaining = [e["bytes_remaining"] for e in latest["files"]]
    assert remaining == sorted(remaining, reverse=True), (
        "files[] not sorted by bytes_remaining descending"
    )


def test_write_coverage_generated_at_is_iso8601_utc(tmp_path):
    """generated_at must be a parseable ISO8601 UTC timestamp."""
    writer = _make_writer(tmp_path)
    artifacts_dir = str(tmp_path / "artifacts")

    write_coverage(writer, [], artifacts_dir)

    latest = json.loads(open(os.path.join(artifacts_dir, "ingest_coverage", "latest.json")).read())
    # Should parse without raising.
    parsed = datetime.fromisoformat(latest["generated_at"].replace("Z", "+00:00"))
    assert parsed.tzinfo is not None


def test_write_coverage_atomic_replace_no_tmp_leftover(tmp_path):
    """No .tmp file should remain after a successful write_coverage call."""
    writer = _make_writer(tmp_path)
    artifacts_dir = str(tmp_path / "artifacts")

    write_coverage(writer, [], artifacts_dir)

    cov_dir = os.path.join(artifacts_dir, "ingest_coverage")
    tmp_files = [f for f in os.listdir(cov_dir) if f.endswith(".tmp")]
    assert tmp_files == [], f"Stale .tmp files found: {tmp_files}"


def test_write_coverage_rotates_to_30_dated_files(tmp_path):
    """After 31 write_coverage calls simulating 31 different days, only the
    last 30 dated files must remain (rotation keeps last 30)."""
    import time as _time

    writer = _make_writer(tmp_path)
    artifacts_dir = str(tmp_path / "artifacts")
    cov_dir = os.path.join(artifacts_dir, "ingest_coverage")
    os.makedirs(cov_dir, exist_ok=True)

    # Manually create 31 dated files to simulate past days.
    for i in range(31):
        date_str = f"2026-01-{i+1:02d}"
        path = os.path.join(cov_dir, f"{date_str}.json")
        with open(path, "w") as f:
            f.write("{}")

    # A single write_coverage call should trigger rotation.
    write_coverage(writer, [], artifacts_dir)

    dated = sorted(
        f for f in os.listdir(cov_dir)
        if f.endswith(".json") and f != "latest.json"
    )
    assert len(dated) <= 30, (
        f"Expected at most 30 dated files after rotation, found {len(dated)}: {dated}"
    )


def test_write_coverage_unprocessed_file_has_null_stats(tmp_path):
    """An unprocessed file (no checkpoint, no stats) must have null for all
    stat fields in the files[] entry."""
    writer = _make_writer(tmp_path)
    artifacts_dir = str(tmp_path / "artifacts")

    fp = str(tmp_path / "session" / "new.jsonl")
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, "w") as f:
        f.write('{"x":1}\n')

    write_coverage(writer, [fp], artifacts_dir)

    latest = json.loads(open(os.path.join(artifacts_dir, "ingest_coverage", "latest.json")).read())
    assert len(latest["files"]) == 1
    entry = latest["files"][0]
    assert entry["status"] == "unprocessed"
    assert entry["lines_total"] is None
    assert entry["events_kept"] is None
    assert entry["dropped_known"] is None
    assert entry["dropped_unknown"] is None
    assert entry["parse_errors"] is None
    assert entry["last_error"] is None
