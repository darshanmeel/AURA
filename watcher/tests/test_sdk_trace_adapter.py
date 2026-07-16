"""Tests for SdkTraceAdapter (Task 1 — Ingest SDK agent traces).

Strict TDD: these tests are written before the adapter implementation.

The SDK trace format is one JSON object per line, written by an external
tracer.  Every event carries `t` (float seconds from run start), `turn`
(int), and `kind` ∈ {run_start, message, thinking, tool_use, tool_result,
text, result, interrupted, run_end}.  There are NO per-line ISO timestamps
and NO per-line uuid — the adapter synthesises both.
"""

import json
import os

import pytest

from aura_watcher.adapters.sdk_trace import SdkTraceAdapter
from aura_watcher.duckdb_writer import DuckDBWriter


# ---------------------------------------------------------------------------
# Fixture lines — one per kind. These mirror the external tracer's output.
# ---------------------------------------------------------------------------

RUN_START = {
    "t": 0.0,
    "turn": 0,
    "kind": "run_start",
    "label": "demo-run",
    "model": "claude-sonnet-4-6",
    "prompt": "Refactor the ingestion path and add SDK trace support please",
    "system_prompt": "You are a helpful coding agent.",
    "cwd": "/home/dev/projects/aura",
    "max_turns": 12,
    "setting_sources": ["project"],
}

MESSAGE = {"t": 0.5, "turn": 1, "kind": "message", "content": "assistant message"}

THINKING = {"t": 0.6, "turn": 1, "kind": "thinking", "content": "let me think..."}

TOOL_USE = {
    "t": 0.7,
    "turn": 1,
    "kind": "tool_use",
    "tool": "Read",
    "id": "toolu_abc",
    "input": {"file_path": "/x/y.py"},
}

TOOL_RESULT = {
    "t": 0.8,
    "turn": 1,
    "kind": "tool_result",
    "id": "toolu_abc",
    "is_error": False,
    "content": "file contents here",
}

TEXT = {"t": 0.9, "turn": 1, "kind": "text", "content": "Here is the answer."}

RESULT = {
    "t": 1.5,
    "turn": 2,
    "kind": "result",
    "raw": {
        "total_cost_usd": 0.0421,
        "duration_ms": 1502,
        "subtype": "success",
        "is_error": False,
        "usage": {
            "input_tokens": 1200,
            "output_tokens": 340,
            "cache_creation_input_tokens": 80,
            "cache_read_input_tokens": 5000,
        },
    },
}

INTERRUPTED = {"t": 1.6, "turn": 2, "kind": "interrupted"}

RUN_END = {
    "t": 1.7,
    "turn": 2,
    "kind": "run_end",
    "duration_s": 1.7,
    "assistant_turns": 2,
    "completed": True,
}

ALL_KINDS = [
    RUN_START,
    MESSAGE,
    THINKING,
    TOOL_USE,
    TOOL_RESULT,
    TEXT,
    RESULT,
    INTERRUPTED,
    RUN_END,
]

# The exact fixed key set every parse_line call must return (None where N/A).
EXPECTED_KEYS = {
    "uuid",
    "session_id",
    "project_id",
    "agent",
    "event_type",
    "ts",
    "file_path",
    "byte_offset",
    "message_id",
    "model",
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "ephemeral_5m_input_tokens",
    "ephemeral_1h_input_tokens",
    "cache_read_input_tokens",
    "source",
    "reported_cost_usd",
    "payload",
}


def _trace_file(tmp_path, name="trace_session_42.jsonl"):
    """Write all fixture kinds to a trace file and return its path + stem."""
    fp = tmp_path / name
    fp.write_bytes(
        b"".join((json.dumps(k) + "\n").encode("utf-8") for k in ALL_KINDS)
    )
    return str(fp), os.path.splitext(name)[0]


# ---------------------------------------------------------------------------
# Fixed-shape contract — every kind returns the identical key set
# ---------------------------------------------------------------------------

def test_fixed_key_set_across_all_kinds(tmp_path):
    """insert_events anchors the column list on events[0] and SKIPS any event
    with a differing key set. So the adapter MUST return the identical key set
    on every kind."""
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    offset = 0
    seen_key_sets = []
    for raw in ALL_KINDS:
        result = adapter.parse_line(raw, file_path=fp, byte_offset=offset)
        offset += 1
        assert result is not None, f"kind={raw.get('kind')} unexpectedly dropped"
        seen_key_sets.append(frozenset(result.keys()))

    # All key sets identical and equal to the documented fixed set.
    assert len(set(seen_key_sets)) == 1, (
        f"key sets diverge across kinds: {set(seen_key_sets)}"
    )
    assert set(seen_key_sets.pop()) == EXPECTED_KEYS


# ---------------------------------------------------------------------------
# event_type mapping: message/result -> 'assistant' (so the session reaches
# stg_assistant_messages -> dim_sessions / fact_model_calls); other kinds
# stay faithful markers.
# ---------------------------------------------------------------------------

EXPECTED_EVENT_TYPE = {
    "run_start": "run_start",
    "message": "assistant",
    "thinking": "thinking",
    "tool_use": "tool_use",
    "tool_result": "tool_result",
    "text": "text",
    "result": "assistant",
    "interrupted": "interrupted",
    "run_end": "run_end",
}


def test_event_type_mapping(tmp_path):
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    offset = 0
    for raw in ALL_KINDS:
        result = adapter.parse_line(raw, file_path=fp, byte_offset=offset)
        offset += 1
        assert result["event_type"] == EXPECTED_EVENT_TYPE[raw["kind"]], raw["kind"]


def test_assistant_events_have_non_null_message_id(tmp_path):
    """stg_assistant_messages filters `message_id IS NOT NULL`; non-assistant
    markers must carry a NULL message_id (mirroring Claude)."""
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    offset = 0
    for raw in ALL_KINDS:
        result = adapter.parse_line(raw, file_path=fp, byte_offset=offset)
        offset += 1
        if EXPECTED_EVENT_TYPE[raw["kind"]] == "assistant":
            assert result["message_id"] is not None, raw["kind"]
        else:
            assert result["message_id"] is None, raw["kind"]


def test_message_event_message_id_is_uuid(tmp_path):
    fp, stem = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    result = adapter.parse_line(MESSAGE, file_path=fp, byte_offset=300)
    assert result["event_type"] == "assistant"
    assert result["message_id"] == f"{stem}:300" == result["uuid"]


def test_result_merges_into_last_assistant_message_id(tmp_path):
    """The cost-bearing result reuses the last message's message_id so the
    verbatim cost merges onto the final assistant turn (turn_count stays ==
    number of messages after stg_assistant_messages dedup)."""
    fp, stem = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    adapter.parse_line(RUN_START, file_path=fp, byte_offset=0)
    msg = adapter.parse_line(MESSAGE, file_path=fp, byte_offset=100)
    res = adapter.parse_line(RESULT, file_path=fp, byte_offset=900)
    assert res["event_type"] == "assistant"
    assert res["message_id"] == msg["message_id"] == f"{stem}:100"
    # result keeps its own distinct uuid (distinct raw_events PK row)
    assert res["uuid"] == f"{stem}:900"


def test_result_message_id_falls_back_to_own_uuid(tmp_path):
    """A result with no prior assistant message this pass (e.g. a result-only
    incremental read) becomes its own assistant turn."""
    fp, stem = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    res = adapter.parse_line(RESULT, file_path=fp, byte_offset=500)
    assert res["event_type"] == "assistant"
    assert res["message_id"] == f"{stem}:500" == res["uuid"]


# ---------------------------------------------------------------------------
# source == 'sdk_trace' on every event; agent == 'sdk'
# ---------------------------------------------------------------------------

def test_source_and_agent(tmp_path):
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    offset = 0
    for raw in ALL_KINDS:
        result = adapter.parse_line(raw, file_path=fp, byte_offset=offset)
        offset += 1
        assert result["source"] == "sdk_trace"
        assert result["agent"] == "sdk"


# ---------------------------------------------------------------------------
# Deterministic uuid == f"{stem}:{byte_offset}"
# ---------------------------------------------------------------------------

def test_uuid_is_deterministic_stem_offset(tmp_path):
    fp, stem = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    for offset in (0, 17, 999):
        result = adapter.parse_line(RUN_START, file_path=fp, byte_offset=offset)
        assert result["uuid"] == f"{stem}:{offset}"
        assert result["session_id"] == stem


# ---------------------------------------------------------------------------
# Model is captured from run_start and attached to later events
# ---------------------------------------------------------------------------

def test_model_attached_from_run_start(tmp_path):
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    offset = 0
    captured = {}
    for raw in ALL_KINDS:
        result = adapter.parse_line(raw, file_path=fp, byte_offset=offset)
        offset += 1
        captured[raw["kind"]] = result["model"]

    assert captured["run_start"] == "claude-sonnet-4-6"
    # later events inherit the run's model
    assert captured["message"] == "claude-sonnet-4-6"
    assert captured["result"] == "claude-sonnet-4-6"
    assert captured["text"] == "claude-sonnet-4-6"


def test_model_none_when_run_start_not_seen(tmp_path):
    """Incremental read starting past offset 0 may never see run_start; model
    must degrade to None rather than crash."""
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    # Feed a non-run_start event first (simulating a mid-file incremental read).
    result = adapter.parse_line(MESSAGE, file_path=fp, byte_offset=200)
    assert result["model"] is None


# ---------------------------------------------------------------------------
# result event carries reported_cost_usd and usage token mapping
# ---------------------------------------------------------------------------

def test_result_cost_and_usage_mapping(tmp_path):
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    result = adapter.parse_line(RESULT, file_path=fp, byte_offset=500)

    assert result["reported_cost_usd"] == 0.0421
    assert result["input_tokens"] == 1200
    assert result["output_tokens"] == 340
    assert result["cache_creation_input_tokens"] == 80
    assert result["cache_read_input_tokens"] == 5000
    # ephemeral fields absent in fixture → None
    assert result["ephemeral_5m_input_tokens"] is None
    assert result["ephemeral_1h_input_tokens"] is None


def test_non_result_events_have_no_cost_or_tokens(tmp_path):
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    offset = 0
    for raw in ALL_KINDS:
        result = adapter.parse_line(raw, file_path=fp, byte_offset=offset)
        offset += 1
        if raw["kind"] == "result":
            continue
        assert result["reported_cost_usd"] is None, raw["kind"]
        assert result["input_tokens"] is None, raw["kind"]
        assert result["output_tokens"] is None, raw["kind"]
        assert result["cache_creation_input_tokens"] is None, raw["kind"]
        assert result["cache_read_input_tokens"] is None, raw["kind"]


# ---------------------------------------------------------------------------
# project_id best-effort from run_start.cwd
# ---------------------------------------------------------------------------

def test_project_id_from_run_start_cwd(tmp_path):
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    offset = 0
    captured = {}
    for raw in ALL_KINDS:
        result = adapter.parse_line(raw, file_path=fp, byte_offset=offset)
        offset += 1
        captured[raw["kind"]] = result["project_id"]
    assert captured["run_start"] == "/home/dev/projects/aura"
    assert captured["message"] == "/home/dev/projects/aura"


def test_project_id_unknown_without_run_start(tmp_path):
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    result = adapter.parse_line(MESSAGE, file_path=fp, byte_offset=200)
    assert result["project_id"] == "unknown"


# ---------------------------------------------------------------------------
# payload is redacted JSON of the raw line
# ---------------------------------------------------------------------------

def test_payload_is_json_of_raw(tmp_path):
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    result = adapter.parse_line(TOOL_USE, file_path=fp, byte_offset=0)
    payload = json.loads(result["payload"])
    assert payload["kind"] == "tool_use"
    assert payload["tool"] == "Read"


# ---------------------------------------------------------------------------
# Defensive: non-dict JSON values return None (mirror ClaudeAdapter)
# ---------------------------------------------------------------------------

def test_non_dict_returns_none(tmp_path):
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    for value in (["a", "b"], "bare", 42, None):
        try:
            result = adapter.parse_line(value, file_path=fp, byte_offset=0)
        except (AttributeError, TypeError) as exc:
            pytest.fail(
                f"parse_line raised {type(exc).__name__} for non-dict {value!r}: {exc}"
            )
        assert result is None, f"non-dict {value!r} should drop to None"


# ---------------------------------------------------------------------------
# Defensive: missing 'kind' is stored, not crashed
# ---------------------------------------------------------------------------

def test_missing_kind_stored_not_crashed(tmp_path):
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    raw = {"t": 0.1, "turn": 0, "data": "no kind here"}
    result = adapter.parse_line(raw, file_path=fp, byte_offset=0)
    assert result is not None
    # event_type degrades to a stable sentinel but the line is preserved.
    assert set(result.keys()) == EXPECTED_KEYS
    assert json.loads(result["payload"])["data"] == "no kind here"


# ---------------------------------------------------------------------------
# no-op parse_skills / parse_mcp_servers (main.py calls them on every adapter)
# ---------------------------------------------------------------------------

def test_parse_skills_and_mcp_are_noop(tmp_path):
    fp, _ = _trace_file(tmp_path)
    adapter = SdkTraceAdapter()
    assert adapter.parse_skills(RUN_START, fp) == []
    assert adapter.parse_mcp_servers(RUN_START, fp) == []


# ---------------------------------------------------------------------------
# Integration: insert_events accepts every kind (identical key sets)
# ---------------------------------------------------------------------------

def test_insert_events_accepts_all_kinds(tmp_path):
    fp, _ = _trace_file(tmp_path)
    db_path = tmp_path / "aura.duckdb"
    writer = DuckDBWriter(str(db_path))
    adapter = SdkTraceAdapter()

    events = []
    offset = 0
    for raw in ALL_KINDS:
        ev = adapter.parse_line(raw, file_path=fp, byte_offset=offset)
        offset += 1
        events.append(ev)

    writer.insert_events(events)

    with writer.get_connection() as conn:
        count = conn.execute("SELECT count(*) FROM raw_events").fetchone()[0]
        # All 9 kinds inserted — none skipped for key mismatch.
        assert count == len(ALL_KINDS)
        # The single cost-bearing row is the result event.
        cost_rows = conn.execute(
            "SELECT reported_cost_usd FROM raw_events "
            "WHERE reported_cost_usd IS NOT NULL"
        ).fetchall()
        assert len(cost_rows) == 1
        assert cost_rows[0][0] == 0.0421
        # source column populated by the adapter (not the table default).
        sources = {
            r[0] for r in conn.execute("SELECT DISTINCT source FROM raw_events").fetchall()
        }
        assert sources == {"sdk_trace"}


# ---------------------------------------------------------------------------
# Schema migration: source + reported_cost_usd columns exist
# ---------------------------------------------------------------------------

def test_schema_has_new_columns(tmp_path):
    db_path = tmp_path / "aura.duckdb"
    writer = DuckDBWriter(str(db_path))
    with writer.get_connection() as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(raw_events)").fetchall()}
    assert "source" in cols
    assert "reported_cost_usd" in cols


def test_migration_adds_columns_to_existing_db(tmp_path):
    """An existing DB created without the new columns must gain them on the
    next DuckDBWriter() init (idempotent ALTER ... ADD COLUMN IF NOT EXISTS)."""
    import duckdb

    db_path = str(tmp_path / "legacy.duckdb")
    # Hand-build a legacy raw_events without source / reported_cost_usd.
    conn = duckdb.connect(db_path)
    conn.execute(
        """
        CREATE TABLE raw_events (
            tenant_id TEXT NOT NULL DEFAULT 'local',
            uuid TEXT NOT NULL,
            session_id TEXT NOT NULL,
            agent TEXT NOT NULL,
            event_type TEXT NOT NULL,
            ts TIMESTAMP NOT NULL,
            file_path TEXT NOT NULL,
            byte_offset BIGINT NOT NULL,
            payload VARCHAR NOT NULL,
            PRIMARY KEY (tenant_id, uuid)
        )
        """
    )
    conn.close()

    # Re-open through the writer — migrations should add the columns.
    DuckDBWriter(db_path)
    conn = duckdb.connect(db_path)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(raw_events)").fetchall()}
    conn.close()
    assert "source" in cols
    assert "reported_cost_usd" in cols
