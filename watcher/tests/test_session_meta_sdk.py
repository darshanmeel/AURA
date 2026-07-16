"""Tests for SDK-trace title extraction in session_meta (Task 1).

The Claude path extracts a session title from the first `type == 'user'` line.
For SDK traces (first non-empty line is a JSON object with a `kind` key) the
title comes from the `run_start` line's `prompt`, truncated to 80 chars.
"""

import json

from aura_watcher.session_meta import _extract_session_title


def test_sdk_title_from_run_start_prompt(tmp_path):
    fp = tmp_path / "trace.jsonl"
    fp.write_text(
        json.dumps({
            "t": 0.0, "turn": 0, "kind": "run_start",
            "model": "claude-sonnet-4-6",
            "prompt": "Implement the SDK trace adapter with strict TDD please",
            "cwd": "/proj/x",
        }) + "\n"
        + json.dumps({"t": 0.5, "turn": 1, "kind": "message", "content": "hi"}) + "\n"
    )
    title = _extract_session_title(str(fp))
    assert title == "Implement the SDK trace adapter with strict TDD please"


def test_sdk_title_truncated_to_80(tmp_path):
    long_prompt = "x" * 200
    fp = tmp_path / "trace.jsonl"
    fp.write_text(
        json.dumps({"kind": "run_start", "prompt": long_prompt}) + "\n"
    )
    title = _extract_session_title(str(fp))
    assert title == "x" * 80


def test_sdk_title_none_when_no_run_start_prompt(tmp_path):
    """An SDK trace whose first line isn't run_start (or has no prompt) yields
    no title rather than mis-parsing as Claude."""
    fp = tmp_path / "trace.jsonl"
    fp.write_text(
        json.dumps({"t": 0.5, "turn": 1, "kind": "message", "content": "hi"}) + "\n"
    )
    title = _extract_session_title(str(fp))
    assert title is None


def test_claude_title_unchanged(tmp_path):
    """The existing Claude path must be unaffected by SDK-trace handling."""
    fp = tmp_path / "claude.jsonl"
    fp.write_text(
        json.dumps({
            "type": "user",
            "message": {"content": "Fix the failing dbt test for fact_turns"},
        }) + "\n"
    )
    title = _extract_session_title(str(fp))
    assert title == "Fix the failing dbt test for fact_turns"
