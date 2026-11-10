"""Unit tests for session-attribute capture (Task 6).

Covers:
  - ClaudeAdapter.parse_session_attributes for all 3 record types
  - Returns None for a normal event and for non-dict input
"""
from aura_watcher.adapters.claude import ClaudeAdapter

# ---------------------------------------------------------------------------
# parse_session_attributes — adapter unit tests
# ---------------------------------------------------------------------------

class TestParseSessionAttributes:
    def setup_method(self):
        self.adapter = ClaudeAdapter()
        # Real layout: <project_dir>/<session_id>.jsonl — session_id is the stem.
        self.file_path = "claude/my-project/session-abc.jsonl"

    def test_ai_title_returns_title(self):
        raw = {"type": "ai-title", "aiTitle": "Refactor auth module", "sessionId": "sess-1"}
        result = self.adapter.parse_session_attributes(raw, self.file_path)
        assert result is not None
        assert result["session_id"] == "sess-1"
        assert result["title"] == "Refactor auth module"
        assert "permission_mode" not in result
        assert "mode" not in result

    def test_ai_title_empty_string_returns_none(self):
        raw = {"type": "ai-title", "aiTitle": "", "sessionId": "sess-2"}
        result = self.adapter.parse_session_attributes(raw, self.file_path)
        assert result is None

    def test_ai_title_missing_key_returns_none(self):
        raw = {"type": "ai-title", "sessionId": "sess-3"}
        result = self.adapter.parse_session_attributes(raw, self.file_path)
        assert result is None

    def test_ai_title_non_string_returns_none(self):
        raw = {"type": "ai-title", "aiTitle": 42, "sessionId": "sess-4"}
        result = self.adapter.parse_session_attributes(raw, self.file_path)
        assert result is None

    def test_permission_mode_returns_permission_mode(self):
        raw = {"type": "permission-mode", "permissionMode": "bypassPermissions", "sessionId": "sess-5"}
        result = self.adapter.parse_session_attributes(raw, self.file_path)
        assert result is not None
        assert result["session_id"] == "sess-5"
        assert result["permission_mode"] == "bypassPermissions"
        assert "title" not in result
        assert "mode" not in result

    def test_permission_mode_all_valid_values(self):
        for val in ("normal", "acceptEdits", "plan", "bypassPermissions"):
            raw = {"type": "permission-mode", "permissionMode": val, "sessionId": "s"}
            result = self.adapter.parse_session_attributes(raw, self.file_path)
            assert result is not None, f"Expected result for permissionMode={val!r}"
            assert result["permission_mode"] == val

    def test_permission_mode_empty_returns_none(self):
        raw = {"type": "permission-mode", "permissionMode": "", "sessionId": "sess-6"}
        result = self.adapter.parse_session_attributes(raw, self.file_path)
        assert result is None

    def test_mode_returns_mode(self):
        raw = {"type": "mode", "mode": "normal", "sessionId": "sess-7"}
        result = self.adapter.parse_session_attributes(raw, self.file_path)
        assert result is not None
        assert result["session_id"] == "sess-7"
        assert result["mode"] == "normal"
        assert "title" not in result
        assert "permission_mode" not in result

    def test_mode_empty_returns_none(self):
        raw = {"type": "mode", "mode": "", "sessionId": "sess-8"}
        result = self.adapter.parse_session_attributes(raw, self.file_path)
        assert result is None

    def test_normal_event_returns_none(self):
        """A regular assistant event must not be treated as a session attribute."""
        raw = {
            "type": "assistant",
            "uuid": "uuid-1",
            "timestamp": "2024-05-23T12:00:00.000Z",
            "sessionId": "sess-9",
            "message": {"id": "msg-1", "content": [], "model": "claude-3-5-sonnet-20241022"},
        }
        result = self.adapter.parse_session_attributes(raw, self.file_path)
        assert result is None

    def test_non_dict_returns_none(self):
        """Non-dict input must not crash and must return None."""
        for value in [["item1"], "bare string", 42, None]:
            result = self.adapter.parse_session_attributes(value, self.file_path)
            assert result is None, f"Expected None for input {value!r}"

    def test_session_id_falls_back_to_file_path_when_no_session_id_key(self):
        """When the record has no sessionId, session_id is the filename stem."""
        # file_path ends with …/my-project/session-abc.jsonl → stem = session-abc
        raw = {"type": "ai-title", "aiTitle": "Some title"}
        result = self.adapter.parse_session_attributes(raw, self.file_path)
        assert result is not None
        # The session_id should be the filename stem, not "unknown".
        assert result["session_id"] == "session-abc"


def test_ai_title_is_redacted():
    """S4: a secret pasted into the first prompt must not survive in the title."""
    raw = {"type": "ai-title", "aiTitle": "rotate api_key=abcdefghijklmnop now", "sessionId": "s"}
    title = ClaudeAdapter().parse_session_attributes(raw, "claude/p/s.jsonl")["title"]
    assert "abcdefghijklmnop" not in title
