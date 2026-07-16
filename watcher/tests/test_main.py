import json
import os
import time
import pytest
import aura_watcher.main as main_module
from aura_watcher.duckdb_writer import DuckDBWriter
from aura_watcher.main import process_file, adapter_for_file, is_workflow_journal, list_backfill_files
from aura_watcher.adapters.claude import ClaudeAdapter
from aura_watcher.adapters.sdk_trace import SdkTraceAdapter
from aura_watcher.checkpoint import CheckpointManager


def _make_line(uuid, ts="2024-05-23T12:00:00Z"):
    """Return a valid JSONL bytes line for the given uuid."""
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
    adapter = ClaudeAdapter()
    cp_manager = CheckpointManager(writer)
    return writer, adapter, cp_manager


# ---------------------------------------------------------------------------
# Original basic ingestion test (preserved)
# ---------------------------------------------------------------------------

def test_ingestion(tmp_path):
    log_dir = tmp_path / "logs" / "session_1"
    log_dir.mkdir(parents=True)
    log_file = log_dir / "log.jsonl"

    writer, adapter, cp_manager = _make_writer_and_deps(tmp_path)

    log_file.write_text(json.dumps({
        "type": "assistant", "uuid": "u1", "timestamp": "2024-05-23T12:00:00Z",
        "message": {"id": "m1", "usage": {"input_tokens": 10}}
    }) + "\n")

    process_file(str(log_file), writer, adapter, cp_manager)

    with writer.get_connection() as conn:
        count = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        assert count == 1


# ---------------------------------------------------------------------------
# W-M7: truncation / rotation test
# ---------------------------------------------------------------------------

def test_truncation_resets_offset(tmp_path):
    """If a file shrinks below the saved checkpoint offset (rotation), the
    watcher must reset to offset 0 and re-read the whole file."""
    log_dir = tmp_path / "logs" / "session_trunc"
    log_dir.mkdir(parents=True)
    log_file = log_dir / "log.jsonl"

    writer, adapter, cp_manager = _make_writer_and_deps(tmp_path)

    # Write two lines and ingest them so a checkpoint is saved.
    line_a = _make_line("uuid-trunc-a")
    line_b = _make_line("uuid-trunc-b")
    log_file.write_bytes(line_a + line_b)
    process_file(str(log_file), writer, adapter, cp_manager)

    # Confirm both events landed and the checkpoint is beyond 0.
    with writer.get_connection() as conn:
        count = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        assert count == 2
        cp_row = conn.execute(
            "SELECT last_offset FROM ingest_checkpoints WHERE file_path = ?",
            [str(log_file)],
        ).fetchone()
        saved_offset = cp_row[0]
        assert saved_offset > 0

    # Simulate rotation: replace the file with a shorter content (new uuid so
    # it is not deduped) whose size is less than saved_offset.
    line_c = _make_line("uuid-trunc-c")
    # Confirm the new content is actually smaller than the saved offset so the
    # truncation guard in process_file will trigger.
    assert len(line_c) < saved_offset, (
        "Fixture assumption failed: line_c must be shorter than saved_offset"
    )
    log_file.write_bytes(line_c)

    # Second pass — should detect shrinkage and re-read from 0.
    process_file(str(log_file), writer, adapter, cp_manager)

    with writer.get_connection() as conn:
        count = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        # uuid-trunc-c must have been ingested (re-read from 0 after rotation).
        assert count == 3
        uuids = {
            r[0]
            for r in conn.execute("SELECT uuid FROM raw_events").fetchall()
        }
        assert "uuid-trunc-c" in uuids


# ---------------------------------------------------------------------------
# W-M7: two-pass multi-line test (incremental ingestion + no duplicate rows)
# ---------------------------------------------------------------------------

def test_two_pass_incremental_no_duplicates(tmp_path):
    """First pass ingests lines already in the file; second pass ingests only
    the newly appended lines.  No duplicate rows must appear, and the
    checkpoint must advance after each pass."""
    log_dir = tmp_path / "logs" / "session_inc"
    log_dir.mkdir(parents=True)
    log_file = log_dir / "log.jsonl"

    writer, adapter, cp_manager = _make_writer_and_deps(tmp_path)

    # --- Pass 1: write two lines ---
    line_1 = _make_line("uuid-inc-1", "2024-05-23T12:00:01Z")
    line_2 = _make_line("uuid-inc-2", "2024-05-23T12:00:02Z")
    log_file.write_bytes(line_1 + line_2)

    process_file(str(log_file), writer, adapter, cp_manager)

    with writer.get_connection() as conn:
        count_after_pass1 = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        cp1 = conn.execute(
            "SELECT last_offset FROM ingest_checkpoints WHERE file_path = ?",
            [str(log_file)],
        ).fetchone()[0]
    assert count_after_pass1 == 2
    assert cp1 > 0

    # --- Pass 2: append two more lines ---
    line_3 = _make_line("uuid-inc-3", "2024-05-23T12:00:03Z")
    line_4 = _make_line("uuid-inc-4", "2024-05-23T12:00:04Z")
    with open(str(log_file), "ab") as fh:
        fh.write(line_3 + line_4)

    process_file(str(log_file), writer, adapter, cp_manager)

    with writer.get_connection() as conn:
        count_after_pass2 = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        cp2 = conn.execute(
            "SELECT last_offset FROM ingest_checkpoints WHERE file_path = ?",
            [str(log_file)],
        ).fetchone()[0]
        all_uuids = {
            r[0]
            for r in conn.execute("SELECT uuid FROM raw_events").fetchall()
        }

    # Exactly 4 distinct rows — no duplicates from re-reading pass-1 lines.
    assert count_after_pass2 == 4
    # Checkpoint advanced.
    assert cp2 > cp1
    # All four events present.
    assert all_uuids == {"uuid-inc-1", "uuid-inc-2", "uuid-inc-3", "uuid-inc-4"}


# ---------------------------------------------------------------------------
# W-C1: per-line byte_offset increases across lines within a single pass
#
# Production code (main.py) currently passes the batch-start offset for every
# line.  The fix (applied in parallel by another agent) should pass the
# cumulative byte offset of each individual line so byte_offset is unique and
# monotonically increasing within a file pass.
# ---------------------------------------------------------------------------

def test_per_line_byte_offset_increases(tmp_path):
    """byte_offset stored in raw_events must be strictly increasing across
    consecutive lines ingested in a single process_file call."""
    log_dir = tmp_path / "logs" / "session_off"
    log_dir.mkdir(parents=True)
    log_file = log_dir / "log.jsonl"

    writer, adapter, cp_manager = _make_writer_and_deps(tmp_path)

    line_1 = _make_line("uuid-off-1", "2024-05-23T12:00:01Z")
    line_2 = _make_line("uuid-off-2", "2024-05-23T12:00:02Z")
    line_3 = _make_line("uuid-off-3", "2024-05-23T12:00:03Z")
    log_file.write_bytes(line_1 + line_2 + line_3)

    process_file(str(log_file), writer, adapter, cp_manager)

    with writer.get_connection() as conn:
        offsets = [
            r[0]
            for r in conn.execute(
                "SELECT byte_offset FROM raw_events ORDER BY byte_offset ASC"
            ).fetchall()
        ]

    assert len(offsets) == 3
    # Each line's byte_offset must be strictly greater than the previous one.
    assert offsets[0] < offsets[1] < offsets[2], (
        f"byte_offset not strictly increasing: {offsets}"
    )


# ---------------------------------------------------------------------------
# Task 1: per-file adapter sniffing
# ---------------------------------------------------------------------------

def test_adapter_for_file_detects_sdk_trace(tmp_path):
    """A file whose first non-empty line is a JSON object with a 'kind' key is
    an SDK trace → SdkTraceAdapter."""
    fp = tmp_path / "trace.jsonl"
    fp.write_text(
        json.dumps({"t": 0.0, "turn": 0, "kind": "run_start", "model": "m"}) + "\n"
    )
    adapter = adapter_for_file(str(fp))
    assert isinstance(adapter, SdkTraceAdapter)


def test_adapter_for_file_detects_claude(tmp_path):
    """A Claude JSONL line (no 'kind' key) → ClaudeAdapter."""
    fp = tmp_path / "claude.jsonl"
    fp.write_text(
        json.dumps({"type": "assistant", "uuid": "u1", "timestamp": "2024-01-01T00:00:00Z"}) + "\n"
    )
    adapter = adapter_for_file(str(fp))
    assert isinstance(adapter, ClaudeAdapter)


def test_adapter_for_file_fresh_sdk_instance_per_call(tmp_path):
    """Each SDK file must get a fresh adapter so per-run state is isolated."""
    fp = tmp_path / "trace.jsonl"
    fp.write_text(json.dumps({"kind": "run_start", "model": "m"}) + "\n")
    a1 = adapter_for_file(str(fp))
    a2 = adapter_for_file(str(fp))
    assert a1 is not a2


def test_adapter_for_file_empty_defaults_to_claude(tmp_path):
    """An empty/unreadable file must default to ClaudeAdapter, not crash."""
    fp = tmp_path / "empty.jsonl"
    fp.write_text("")
    adapter = adapter_for_file(str(fp))
    assert isinstance(adapter, ClaudeAdapter)


def test_adapter_for_file_skips_blank_leading_lines(tmp_path):
    """Sniffing reads the first NON-EMPTY line, not literally line 1."""
    fp = tmp_path / "lead.jsonl"
    fp.write_text("\n\n" + json.dumps({"kind": "message"}) + "\n")
    adapter = adapter_for_file(str(fp))
    assert isinstance(adapter, SdkTraceAdapter)


def test_adapter_for_file_non_dict_first_line_defaults_claude(tmp_path):
    """A valid-JSON but non-dict first line (e.g. a list) defaults to Claude."""
    fp = tmp_path / "weird.jsonl"
    fp.write_text(json.dumps(["a", "b"]) + "\n")
    adapter = adapter_for_file(str(fp))
    assert isinstance(adapter, ClaudeAdapter)


# ---------------------------------------------------------------------------
# Fix 2 (2026-07-13): workflow-journal exclusion predicate
# ---------------------------------------------------------------------------

def test_is_workflow_journal_matches_nested_journal():
    p = "/logs/claude/proj/session/subagents/workflows/wf_abc-123/journal.jsonl"
    assert is_workflow_journal(p) is True


def test_is_workflow_journal_matches_windows_style_path():
    p = "C:\\logs\\claude\\proj\\subagents\\workflows\\wf_abc\\journal.jsonl"
    assert is_workflow_journal(p) is True


def test_is_workflow_journal_does_not_match_normal_session_file():
    p = "/logs/claude/proj/session_id.jsonl"
    assert is_workflow_journal(p) is False


def test_is_workflow_journal_does_not_match_journal_outside_workflows_dir():
    # Same filename, but not nested under subagents/workflows/ — must not match.
    p = "/logs/claude/proj/session/journal.jsonl"
    assert is_workflow_journal(p) is False


def test_is_workflow_journal_does_not_match_other_files_in_workflows_dir():
    p = "/logs/claude/proj/subagents/workflows/wf_abc/other.jsonl"
    assert is_workflow_journal(p) is False


def test_backfill_skips_workflow_journal_lines_zero_events(tmp_path):
    """End-to-end: a real-shaped workflow journal line (no uuid/ts) yields
    zero kept events via ClaudeAdapter even if process_file were called on it
    directly (defence in depth beyond the path-based exclusion)."""
    log_dir = tmp_path / "logs" / "proj" / "session" / "subagents" / "workflows" / "wf_x"
    log_dir.mkdir(parents=True)
    journal_file = log_dir / "journal.jsonl"
    journal_file.write_text(
        json.dumps({"type": "started", "key": "v2:abc", "agentId": "a1"}) + "\n"
        + json.dumps({"type": "result", "key": "v2:abc", "agentId": "a1", "result": {}}) + "\n"
    )

    writer, adapter, cp_manager = _make_writer_and_deps(tmp_path)
    process_file(str(journal_file), writer, adapter, cp_manager)

    with writer.get_connection() as conn:
        count = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
    assert count == 0
    assert is_workflow_journal(str(journal_file)) is True


def test_process_file_ingests_sdk_trace_end_to_end(tmp_path):
    """process_file must select the SDK adapter and land all 9 kinds, with the
    result event carrying reported_cost_usd."""
    fp = tmp_path / "sdk_session.jsonl"
    kinds = [
        {"t": 0.0, "turn": 0, "kind": "run_start", "model": "claude-sonnet-4-6",
         "prompt": "do the thing", "cwd": "/proj/x"},
        {"t": 0.5, "turn": 1, "kind": "message", "content": "hi"},
        {"t": 0.6, "turn": 1, "kind": "thinking", "content": "..."},
        {"t": 0.7, "turn": 1, "kind": "tool_use", "tool": "Read", "id": "t1", "input": {}},
        {"t": 0.8, "turn": 1, "kind": "tool_result", "id": "t1", "is_error": False, "content": "ok"},
        {"t": 0.9, "turn": 1, "kind": "text", "content": "answer"},
        {"t": 1.5, "turn": 2, "kind": "result",
         "raw": {"total_cost_usd": 0.099, "usage": {"input_tokens": 10, "output_tokens": 3}}},
        {"t": 1.6, "turn": 2, "kind": "interrupted"},
        {"t": 1.7, "turn": 2, "kind": "run_end", "duration_s": 1.7, "completed": True},
    ]
    fp.write_bytes(b"".join((json.dumps(k) + "\n").encode("utf-8") for k in kinds))

    db_path = tmp_path / "aura.duckdb"
    writer = DuckDBWriter(str(db_path))
    cp_manager = CheckpointManager(writer)
    adapter = adapter_for_file(str(fp))
    process_file(str(fp), writer, adapter, cp_manager)

    with writer.get_connection() as conn:
        count = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        assert count == 9
        # The cost-bearing 'result' is mapped to event_type='assistant' (so it
        # reaches stg_assistant_messages) and is the only row with a cost.
        cost = conn.execute(
            "SELECT reported_cost_usd FROM raw_events WHERE reported_cost_usd IS NOT NULL"
        ).fetchone()[0]
        assert cost == 0.099
        # message + result both surface as assistant with a non-null message_id
        # (the gate stg_assistant_messages requires).
        assistant_with_id = conn.execute(
            "SELECT count(*) FROM raw_events "
            "WHERE event_type = 'assistant' AND message_id IS NOT NULL"
        ).fetchone()[0]
        assert assistant_with_id == 2
        sources = {r[0] for r in conn.execute("SELECT DISTINCT source FROM raw_events").fetchall()}
        assert sources == {"sdk_trace"}


# ---------------------------------------------------------------------------
# 2026-07-14 fix: list_backfill_files resilience + oldest-first ordering
# ---------------------------------------------------------------------------

def test_list_backfill_files_drops_vanished_file_without_raising(tmp_path, monkeypatch):
    """A file present at glob() time but gone by the time list_backfill_files
    stats it for mtime must be silently dropped from the result -- never let
    an exception escape and abort the whole listing. The other, still-present
    files must still come back."""
    d = tmp_path / "logs"
    d.mkdir()
    f1 = d / "a.jsonl"
    f2 = d / "b.jsonl"
    f1.write_text("{}\n")
    f2.write_text("{}\n")

    # Never actually created on disk -- simulates a file that existed at
    # enumeration time (e.g. an ephemeral subagent-workflow file) and was
    # deleted before the mtime stat call.
    vanished = str(d / "vanished.jsonl")

    def fake_glob(pattern, recursive=False):
        return [str(f1), vanished, str(f2)]

    monkeypatch.setattr(main_module.glob, "glob", fake_glob)

    # Must not raise.
    result = list_backfill_files([str(d)])

    assert vanished not in result
    assert str(f1) in result
    assert str(f2) in result
    assert len(result) == 2


def test_list_backfill_files_oldest_first(tmp_path):
    """The backfill listing must be sorted ascending by mtime (oldest file
    first) -- a deliberate 2026-07-14 reversal of the prior newest-first
    order, so the raw_events ingestion frontier advances truthfully from the
    oldest unprocessed file instead of jumping to ~now immediately."""
    d = tmp_path / "logs"
    d.mkdir()
    old = d / "old.jsonl"
    mid = d / "mid.jsonl"
    new = d / "new.jsonl"
    for f in (old, mid, new):
        f.write_text("{}\n")

    # Set explicit, well-separated mtimes so ordering is deterministic
    # regardless of filesystem timestamp resolution.
    now = time.time()
    os.utime(old, (now - 300, now - 300))
    os.utime(mid, (now - 150, now - 150))
    os.utime(new, (now, now))

    result = list_backfill_files([str(d)])

    assert result == [str(old), str(mid), str(new)]


def test_list_backfill_files_excludes_workflow_journals(tmp_path):
    """list_backfill_files must still drop workflow-journal files (existing
    behaviour, preserved through the refactor into a standalone function)."""
    d = tmp_path / "logs" / "proj" / "session" / "subagents" / "workflows" / "wf_x"
    d.mkdir(parents=True)
    journal = d / "journal.jsonl"
    journal.write_text(json.dumps({"type": "started"}) + "\n")

    normal_dir = tmp_path / "logs" / "proj2"
    normal_dir.mkdir(parents=True)
    normal = normal_dir / "session.jsonl"
    normal.write_text(json.dumps({"type": "assistant", "uuid": "u1"}) + "\n")

    result = list_backfill_files([str(tmp_path / "logs")])

    assert str(journal) not in result
    assert str(normal) in result
