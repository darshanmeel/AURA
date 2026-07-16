"""Unit tests for session-attribute capture (Task 6).

Covers:
  - ClaudeAdapter.parse_session_attributes for all 3 record types
  - Returns None for a normal event and for non-dict input
  - DuckDBWriter.upsert_session_attributes: insert then update (COALESCE invariants)
"""
import os
import pytest
from aura_watcher.adapters.claude import ClaudeAdapter
from aura_watcher.duckdb_writer import DuckDBWriter


# ---------------------------------------------------------------------------
# parse_session_attributes — adapter unit tests
# ---------------------------------------------------------------------------

class TestParseSessionAttributes:
    def setup_method(self):
        self.adapter = ClaudeAdapter()
        # Real layout: <project_dir>/<session_id>.jsonl — session_id is the stem.
        self.file_path = os.path.join("logs", "claude", "my-project", "session-abc.jsonl")

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


# ---------------------------------------------------------------------------
# upsert_session_attributes — DuckDB writer tests
# ---------------------------------------------------------------------------

class TestUpsertSessionAttributes:
    def setup_method(self, tmp_path_factory):
        # Each test gets its own DuckDB so tests don't interfere.
        pass

    def _make_writer(self, tmp_path):
        return DuckDBWriter(str(tmp_path / "aura.duckdb"))

    def test_insert_new_session(self, tmp_path):
        writer = self._make_writer(tmp_path)
        writer.upsert_session_attributes(
            "sess-new",
            title="My Session",
            permission_mode="normal",
            mode="plan",
        )
        with writer.get_connection() as conn:
            row = conn.execute(
                "SELECT session_title, permission_mode, mode FROM session_meta WHERE session_id = ?",
                ["sess-new"],
            ).fetchone()
        assert row is not None
        assert row[0] == "My Session"
        assert row[1] == "normal"
        assert row[2] == "plan"

    def test_update_does_not_wipe_existing_values_with_none(self, tmp_path):
        """COALESCE(excluded, existing): a NULL incoming value must NOT wipe a stored value."""
        writer = self._make_writer(tmp_path)
        # First upsert sets all three.
        writer.upsert_session_attributes(
            "sess-coalesce",
            title="Original Title",
            permission_mode="normal",
            mode="plan",
        )
        # Second upsert provides only a new mode; title and permission_mode are None.
        writer.upsert_session_attributes(
            "sess-coalesce",
            title=None,
            permission_mode=None,
            mode="acceptEdits",
        )
        with writer.get_connection() as conn:
            row = conn.execute(
                "SELECT session_title, permission_mode, mode FROM session_meta WHERE session_id = ?",
                ["sess-coalesce"],
            ).fetchone()
        assert row[0] == "Original Title"      # not wiped
        assert row[1] == "normal"              # not wiped
        assert row[2] == "acceptEdits"         # updated

    def test_ai_title_overrides_stored_title(self, tmp_path):
        """A new non-NULL title from ai-title must override the old value."""
        writer = self._make_writer(tmp_path)
        writer.upsert_session_attributes("sess-title", title="Prompt-derived title")
        writer.upsert_session_attributes("sess-title", title="AI-derived title")
        with writer.get_connection() as conn:
            row = conn.execute(
                "SELECT session_title FROM session_meta WHERE session_id = ?",
                ["sess-title"],
            ).fetchone()
        assert row[0] == "AI-derived title"

    def test_last_permission_mode_wins(self, tmp_path):
        """Multiple permission-mode records: the last upsert value is stored."""
        writer = self._make_writer(tmp_path)
        writer.upsert_session_attributes("sess-pm", permission_mode="normal")
        writer.upsert_session_attributes("sess-pm", permission_mode="bypassPermissions")
        with writer.get_connection() as conn:
            row = conn.execute(
                "SELECT permission_mode FROM session_meta WHERE session_id = ?",
                ["sess-pm"],
            ).fetchone()
        assert row[0] == "bypassPermissions"

    def test_all_none_skips_write(self, tmp_path):
        """When title/permission_mode/mode are all None, no row must be written."""
        writer = self._make_writer(tmp_path)
        writer.upsert_session_attributes("sess-skip", title=None, permission_mode=None, mode=None)
        with writer.get_connection() as conn:
            row = conn.execute(
                "SELECT session_id FROM session_meta WHERE session_id = ?",
                ["sess-skip"],
            ).fetchone()
        assert row is None, "No row should have been inserted when all values are None"

    def test_partial_upsert_title_only(self, tmp_path):
        """Upserting only a title must leave permission_mode and mode NULL for a new session."""
        writer = self._make_writer(tmp_path)
        writer.upsert_session_attributes("sess-title-only", title="Just the title")
        with writer.get_connection() as conn:
            row = conn.execute(
                "SELECT session_title, permission_mode, mode FROM session_meta WHERE session_id = ?",
                ["sess-title-only"],
            ).fetchone()
        assert row[0] == "Just the title"
        assert row[1] is None
        assert row[2] is None

    def test_migration_columns_exist(self, tmp_path):
        """After DuckDBWriter init, session_meta must have permission_mode and mode columns."""
        writer = self._make_writer(tmp_path)
        with writer.get_connection() as conn:
            cols = [row[0] for row in conn.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'session_meta'"
            ).fetchall()]
        assert "permission_mode" in cols, "permission_mode column must exist in session_meta"
        assert "mode" in cols, "mode column must exist in session_meta"
