"""Tests for coverage.write_coverage (dict inputs, logical paths)."""
import json
import os
from datetime import UTC, datetime

from aura_watcher.coverage import write_coverage


def _cp(offset):
    return {"last_offset": offset, "last_seen_at": "2026-11-01T10:00:00"}


def _stats(**kw):
    return {"lines_total": 0, "events_kept": 0, "dropped_known": 0, "dropped_unknown": 0,
            "parse_errors": 0, "last_error": None, **kw}


def _latest(art):
    with open(os.path.join(art, "ingest_coverage", "latest.json"), encoding="utf-8") as f:
        return json.load(f)


def test_summary_and_files_array(tmp_path):
    art = str(tmp_path / "artifacts")
    files = [("claude/p/full.jsonl", 100), ("claude/p/partial.jsonl", 300), ("claude/p/new.jsonl", 50)]
    cps = {"claude/p/full.jsonl": _cp(100), "claude/p/partial.jsonl": _cp(100)}
    stats = {"claude/p/full.jsonl": _stats(lines_total=2, events_kept=2),
             "claude/p/partial.jsonl": _stats(lines_total=1, events_kept=1, parse_errors=1, last_error="boom")}
    write_coverage(files, cps, stats, art, ["/logs/claude"])
    doc = _latest(art)
    s = doc["summary"]
    assert (s["files_total"], s["files_full"], s["files_partial"], s["files_unprocessed"]) == (3, 1, 1, 1)
    assert (s["bytes_total"], s["bytes_ingested"], s["bytes_remaining"]) == (450, 200, 250)
    assert (s["events_kept"], s["parse_errors"]) == (3, 1)
    assert doc["scan_dirs"] == ["/logs/claude"]
    # Only partial + unprocessed, biggest remaining first.
    assert [(e["path"], e["status"], e["bytes_remaining"]) for e in doc["files"]] == [
        ("claude/p/partial.jsonl", "partial", 200), ("claude/p/new.jsonl", "unprocessed", 50)]
    assert doc["files"][0]["last_error"] == "boom"
    assert doc["files"][1]["lines_total"] is None


def test_dated_file_latest_and_no_tmp(tmp_path):
    art = str(tmp_path / "artifacts")
    write_coverage([], {}, {}, art)
    cov = os.path.join(art, "ingest_coverage")
    names = sorted(os.listdir(cov))
    assert names == sorted(["latest.json", datetime.now(UTC).strftime("%Y-%m-%d") + ".json"])
    datetime.fromisoformat(_latest(art)["generated_at"])


def test_rotates_to_30_dated_files(tmp_path):
    art = str(tmp_path / "artifacts")
    cov = os.path.join(art, "ingest_coverage")
    os.makedirs(cov)
    for d in range(1, 41):
        open(os.path.join(cov, f"2000-01-{d:02d}.json"), "w").close()
    write_coverage([], {}, {}, art)
    assert len([f for f in os.listdir(cov) if f != "latest.json"]) == 30
