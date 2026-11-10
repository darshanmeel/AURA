import json
import logging

import pytest

from aura_watcher.adapters.claude import KNOWN_NON_EVENT_TYPES, ClaudeAdapter


def test_parse_assistant_message():
    adapter = ClaudeAdapter()
    raw_line = {
        "type": "assistant",
        "uuid": "uuid-1",
        "timestamp": "2024-05-23T12:00:00.000Z",
        "message": {
            "id": "msg-1",
            "content": [],
            "model": "claude-3-5-sonnet-20241022",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "cache_creation_input_tokens": 10,
                "cache_read_input_tokens": 200
            }
        }
    }
    # No sessionId in the line: the fallback is the file stem (S8)
    file_path = "claude/-home-dev-proj/session_abc.jsonl"
    event = adapter.parse_line(raw_line, file_path=file_path, byte_offset=0)
    assert event["uuid"] == "uuid-1"
    assert event["session_id"] == "session_abc"
    assert event["input_tokens"] == 100
    # (100 + 10 + 200) / 200000 = 0.00155
    assert event["context_pct"] == 0.00155


# ---------------------------------------------------------------------------
# W-M7: parse_line on a line missing uuid returns None
# ---------------------------------------------------------------------------

def test_parse_line_missing_uuid_returns_none():
    """A line with no uuid field must be dropped (returns None) because the
    schema has a NOT NULL primary-key constraint on uuid."""
    adapter = ClaudeAdapter()
    raw = {
        "type": "assistant",
        # uuid intentionally absent
        "timestamp": "2024-05-23T12:00:00Z",
        "message": {"id": "m1", "usage": {"input_tokens": 5}},
    }
    result = adapter.parse_line(raw, file_path="some/path/log.jsonl", byte_offset=0)
    assert result is None


def test_parse_line_missing_ts_returns_none():
    """A line with no timestamp/ts field must be dropped."""
    adapter = ClaudeAdapter()
    raw = {
        "type": "assistant",
        "uuid": "uuid-no-ts",
        # timestamp intentionally absent
        "message": {"id": "m1", "usage": {"input_tokens": 5}},
    }
    result = adapter.parse_line(raw, file_path="some/path/log.jsonl", byte_offset=0)
    assert result is None


def test_parse_line_missing_uuid_and_ts_returns_none():
    """A line missing both uuid and ts must return None."""
    adapter = ClaudeAdapter()
    raw = {
        "type": "user",
        "message": {"content": "hello"},
    }
    result = adapter.parse_line(raw, file_path="some/path/log.jsonl", byte_offset=0)
    assert result is None


# ---------------------------------------------------------------------------
# W-M7: unknown event type stored verbatim (spec §4 v2 fix)
# ---------------------------------------------------------------------------

def test_parse_line_unknown_event_type_stored():
    """An unrecognised event type must not be dropped. The returned dict must
    have event_type set to the raw type value so it lands in raw_events."""
    adapter = ClaudeAdapter()
    raw = {
        "type": "some_future_event",
        "uuid": "uuid-unknown",
        "timestamp": "2024-05-23T13:00:00Z",
        "data": {"foo": "bar"},
    }
    result = adapter.parse_line(raw, file_path="logs/proj/session_x/f.jsonl", byte_offset=42)
    assert result is not None, "Unknown event type must not return None"
    assert result["event_type"] == "some_future_event"
    assert result["uuid"] == "uuid-unknown"


def test_parse_line_unknown_event_type_payload_contains_raw():
    """The payload stored for an unknown event must be the full JSON of the
    raw line (possibly redacted) so no data is silently discarded."""
    adapter = ClaudeAdapter()
    raw = {
        "type": "mystery_type",
        "uuid": "uuid-mystery",
        "timestamp": "2024-05-23T14:00:00Z",
        "extra_field": "preserved",
    }
    result = adapter.parse_line(raw, file_path="logs/proj/session_x/f.jsonl", byte_offset=0)
    assert result is not None
    # payload must be valid JSON and contain the original type value.
    payload = json.loads(result["payload"])
    assert payload.get("type") == "mystery_type"
    assert payload.get("extra_field") == "preserved"


# ---------------------------------------------------------------------------
# W-M7: valid-JSON non-dict line handled gracefully
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# RC3: known non-event control records use DEBUG (not WARNING) logging
# ---------------------------------------------------------------------------

def test_known_non_event_types_constant_has_expected_members():
    """KNOWN_NON_EVENT_TYPES must include all documented control-record types."""
    expected = {
        "last-prompt", "mode", "permission-mode",
        "file-history-snapshot", "ai-title", "queue-operation", "summary",
    }
    assert expected.issubset(KNOWN_NON_EVENT_TYPES), (
        f"Missing types: {expected - KNOWN_NON_EVENT_TYPES}"
    )


def test_known_non_event_type_drops_with_debug_not_warning(caplog):
    """A line whose type is in KNOWN_NON_EVENT_TYPES and lacks uuid/ts must
    produce a DEBUG log entry, NOT a WARNING."""
    adapter = ClaudeAdapter()
    for non_event_type in KNOWN_NON_EVENT_TYPES:
        raw = {"type": non_event_type, "data": "some control payload"}
        with caplog.at_level(logging.DEBUG, logger="aura_watcher.adapters.claude"):
            caplog.clear()
            result = adapter.parse_line(raw, file_path="logs/f.jsonl", byte_offset=0)

        assert result is None, f"type={non_event_type} must be dropped (return None)"

        # Must have a DEBUG record, not a WARNING.
        debug_records = [r for r in caplog.records if r.levelno == logging.DEBUG]
        warn_records  = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert debug_records, (
            f"Expected a DEBUG log for known non-event type '{non_event_type}', got none"
        )
        assert not warn_records, (
            f"WARNING emitted for known non-event type '{non_event_type}' — should be DEBUG"
        )


def test_unknown_missing_uuid_type_emits_debug_not_warning(caplog):
    """A line with an unrecognised type that is missing uuid/ts must still be
    observably dropped, but at DEBUG (not WARNING) — updated 2026-07-13 to
    stop flooding synchronous log I/O during backfill (e.g. workflow-journal
    files where every line is missing uuid/ts). The drop is still surfaced
    via file_stats.dropped_unknown, so nothing is silently lost."""
    adapter = ClaudeAdapter()
    raw = {"type": "some_future_type_without_uuid", "data": "x"}
    with caplog.at_level(logging.DEBUG, logger="aura_watcher.adapters.claude"):
        result = adapter.parse_line(raw, file_path="logs/f.jsonl", byte_offset=0)

    assert result is None
    debug_records = [r for r in caplog.records if r.levelno == logging.DEBUG]
    warn_records  = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert debug_records, "Expected a DEBUG log for unknown type with missing uuid/ts"
    assert not warn_records, "WARNING should no longer fire for this drop (flood fix)"


# ---------------------------------------------------------------------------
# RC2: payload is always valid JSON (redact_obj before json.dumps)
# ---------------------------------------------------------------------------

def test_payload_is_valid_json_with_newline_blob(monkeypatch):
    """With AURA_REDACT_PAYLOAD=true (default), a raw dict whose string value
    contains \\n followed by a 300-char blob must produce a payload that
    json.loads() can parse without error."""
    import aura_watcher.adapters.claude as _mod
    monkeypatch.setattr(_mod, "_REDACT_ENABLED", True)

    blob = "A" * 300
    adapter = ClaudeAdapter()
    raw = {
        "type": "assistant",
        "uuid": "rc2-test-1",
        "timestamp": "2024-05-23T12:00:00Z",
        "message": {"content": "x\n" + blob},
    }
    event = adapter.parse_line(raw, file_path="logs/proj/session/f.jsonl", byte_offset=0)
    assert event is not None
    parsed = json.loads(event["payload"])  # must not raise
    assert isinstance(parsed, dict)


def test_parse_line_non_dict_json_handled_gracefully():
    """If a JSONL line is valid JSON but not a dict (e.g. a bare string or
    list), parse_line must not raise — it should either return None or a safe
    default dict.  The main loop wraps in try/except, but the adapter itself
    should not propagate an unhandled AttributeError from .get() on a non-dict."""
    adapter = ClaudeAdapter()

    # A JSON array — parse_line receives the result of json.loads(), which
    # would be a list.  The production main loop calls json.loads() first and
    # passes the result to parse_line, so we simulate that here.
    non_dict_inputs = [
        ["item1", "item2"],   # list
        "bare string",        # str
        42,                   # int
        None,                 # null
    ]

    for value in non_dict_inputs:
        try:
            result = adapter.parse_line(value, file_path="logs/f.jsonl", byte_offset=0)
            # Acceptable outcomes: None (dropped) or a dict (should not happen
            # for non-dict input, but must not crash).
            assert result is None or isinstance(result, dict), (
                f"parse_line({value!r}) returned unexpected type {type(result)}"
            )
        except (AttributeError, TypeError) as exc:
            pytest.fail(
                f"parse_line raised {type(exc).__name__} for non-dict input "
                f"{value!r}: {exc}"
            )


def test_project_id_decoded_from_logical_path():
    raw = {"type": "user", "uuid": "u1", "timestamp": "2026-11-01T10:00:00Z", "message": {"content": "hi"}}
    ev = ClaudeAdapter().parse_line(raw, file_path="claude/-home-dev-my--app/s1.jsonl", byte_offset=0)
    assert ev["project_id"] == "/home/dev/my-app"
    assert ev["session_id"] == "s1"


def test_is_sidechain_null_becomes_false():
    """S1: isSidechain: null must not produce a NULL in a required column."""
    raw = {"type": "user", "uuid": "u1", "timestamp": "2026-11-01T10:00:00Z", "isSidechain": None}
    assert ClaudeAdapter().parse_line(raw, file_path="claude/p/s.jsonl", byte_offset=0)["is_sidechain"] is False


# ---------------------------------------------------------------------------
# S14: skills and MCP servers from attachment events
# ---------------------------------------------------------------------------

def test_parse_skills_invoked_skills_and_listing():
    a = ClaudeAdapter()
    invoked = {"type": "attachment", "sessionId": "s1", "attachment": {
        "type": "invoked_skills", "skills": [{"name": "docs"}, {"name": "docs"}, {"name": " review "}, "bad"]}}
    assert [(r["session_id"], r["skill_name"], r["is_initial"]) for r in a.parse_skills(invoked, "claude/p/s1.jsonl")] \
        == [("s1", "docs", True), ("s1", "review", True)]
    listing = {"type": "attachment", "attachment": {
        "type": "skill_listing", "content": "- plugin:alpha: does a\n- beta: does b\nnot a bullet"}}
    rows = a.parse_skills(listing, "claude/p/s2.jsonl")
    assert [r["skill_name"] for r in rows] == ["plugin:alpha", "beta"]
    assert rows[0]["session_id"] == "s2"  # stem fallback (S8)
    assert a.parse_skills({"type": "user"}, "claude/p/s.jsonl") == []


def test_parse_mcp_servers():
    a = ClaudeAdapter()
    raw = {"type": "attachment", "sessionId": "s1", "attachment": {
        "type": "mcp_instructions_delta", "addedNames": ["plugin:ctx:ctx", "plugin:ctx:ctx", "", 5]}}
    assert [r["mcp_server"] for r in a.parse_mcp_servers(raw, "claude/p/s1.jsonl")] == ["plugin:ctx:ctx"]
    assert a.parse_mcp_servers({"type": "attachment", "attachment": {"type": "skills"}}, "claude/p/s.jsonl") == []
