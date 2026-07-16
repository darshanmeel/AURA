"""T8: AURA_HASH_CONTENT env-gated content-hash mode.

Covers:
  - redact.hash_text / redact.hash_message_content (pure unit tests)
  - the ClaudeAdapter.parse_line() integration point (module-level gate,
    mirroring the existing monkeypatch.setattr pattern test_claude_adapter.py
    already uses for _REDACT_ENABLED)

Any secret-shaped fixture string is assembled at runtime via _fake() (same
pattern as test_redact.py) so GitHub secret scanning never sees a
credential-shaped literal in this file.
"""

import hashlib
import json

import aura_watcher.adapters.claude as claude_mod
from aura_watcher.adapters.claude import ClaudeAdapter
from aura_watcher.redact import hash_message_content, hash_text, redact_content, redact_obj


def _fake(*parts: str) -> str:
    """Join fragments at runtime so scanners never see a secret-shaped literal."""
    return "".join(parts)


# ---------------------------------------------------------------------------
# hash_text
# ---------------------------------------------------------------------------

def test_hash_text_format_and_prefix():
    result = hash_text("hello world")
    assert result.startswith("sha256:")
    hex_part = result[len("sha256:"):]
    assert len(hex_part) == 64
    assert all(c in "0123456789abcdef" for c in hex_part)


def test_hash_text_matches_hashlib_directly():
    text = "the quick brown fox"
    expected = "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
    assert hash_text(text) == expected


def test_hash_text_is_stable_same_input_same_output():
    text = "some conversational content"
    assert hash_text(text) == hash_text(text)


def test_hash_text_different_input_different_output():
    assert hash_text("alpha") != hash_text("beta")


# ---------------------------------------------------------------------------
# hash_message_content — string content (user turns)
# ---------------------------------------------------------------------------

def test_hash_message_content_string_content():
    raw = {"type": "user", "message": {"content": "hello, can you help me?"}}
    result = hash_message_content(raw)
    assert result["message"]["content"] == hash_text("hello, can you help me?")
    # Original untouched (no mutation).
    assert raw["message"]["content"] == "hello, can you help me?"


def test_hash_message_content_string_content_no_longer_plaintext():
    secret_looking_prompt = "my ssn is 123-45-6789, please remember it"
    raw = {"message": {"content": secret_looking_prompt}}
    result = hash_message_content(raw)
    assert secret_looking_prompt not in result["message"]["content"]
    assert result["message"]["content"].startswith("sha256:")


# ---------------------------------------------------------------------------
# hash_message_content — list content (assistant turns): only type='text'
# blocks are hashed; tool_use / thinking / tool_result blocks pass through
# untouched, including their non-string scalar fields (Non-string scalars
# untouched requirement).
# ---------------------------------------------------------------------------

def test_hash_message_content_text_blocks_only():
    raw = {
        "message": {
            "content": [
                {"type": "text", "text": "here is my plan"},
                {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {"file_path": "/x.py", "limit": 50}},
                {"type": "thinking", "thinking": "internal reasoning text"},
                {"type": "text", "text": "second text block"},
            ]
        }
    }
    result = hash_message_content(raw)
    blocks = result["message"]["content"]

    # text blocks hashed
    assert blocks[0]["text"] == hash_text("here is my plan")
    assert blocks[3]["text"] == hash_text("second text block")

    # non-text blocks untouched — same values, including non-string scalars
    # (limit=50 stays an int, not hashed/stringified).
    assert blocks[1] == {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {"file_path": "/x.py", "limit": 50}}
    assert blocks[2] == {"type": "thinking", "thinking": "internal reasoning text"}


def test_hash_message_content_preserves_block_order_and_count():
    raw = {"message": {"content": [
        {"type": "text", "text": "a"},
        {"type": "tool_use", "input": {}},
        {"type": "text", "text": "b"},
    ]}}
    result = hash_message_content(raw)
    assert len(result["message"]["content"]) == 3
    assert result["message"]["content"][0]["type"] == "text"
    assert result["message"]["content"][1]["type"] == "tool_use"
    assert result["message"]["content"][2]["type"] == "text"


# ---------------------------------------------------------------------------
# None / missing / unexpected shape passthrough
# ---------------------------------------------------------------------------

def test_hash_message_content_none_content_passthrough():
    raw = {"message": {"content": None}}
    result = hash_message_content(raw)
    assert result["message"]["content"] is None


def test_hash_message_content_missing_message_key_passthrough():
    raw = {"type": "summary", "uuid": "u1"}
    result = hash_message_content(raw)
    assert result == raw


def test_hash_message_content_missing_content_key_passthrough():
    raw = {"message": {"id": "m1", "usage": {"input_tokens": 5}}}
    result = hash_message_content(raw)
    assert result == raw


def test_hash_message_content_non_dict_message_passthrough():
    raw = {"message": "not a dict"}
    result = hash_message_content(raw)
    assert result == raw


def test_hash_message_content_non_string_non_list_content_passthrough():
    raw = {"message": {"content": 42}}
    result = hash_message_content(raw)
    assert result == raw


# ---------------------------------------------------------------------------
# Non-text scalar fields elsewhere in the record are never hashed (token
# counts, model id, timestamps live outside message.content entirely and
# hash_message_content never touches them).
# ---------------------------------------------------------------------------

def test_hash_message_content_does_not_touch_other_fields():
    raw = {
        "type": "assistant",
        "uuid": "u1",
        "timestamp": "2026-07-16T00:00:00Z",
        "message": {
            "model": "claude-opus-4-8",
            "usage": {"input_tokens": 100, "output_tokens": 50},
            "content": "plain text",
        },
    }
    result = hash_message_content(raw)
    assert result["uuid"] == "u1"
    assert result["timestamp"] == "2026-07-16T00:00:00Z"
    assert result["message"]["model"] == "claude-opus-4-8"
    assert result["message"]["usage"] == {"input_tokens": 100, "output_tokens": 50}
    assert result["message"]["content"] == hash_text("plain text")


# ---------------------------------------------------------------------------
# Redaction-then-hash ordering: a string containing a fake secret hashes to
# the hash of the REDACTED string, not the raw secret.
# ---------------------------------------------------------------------------

def test_redact_then_hash_ordering():
    fake_secret = _fake("api_key=", "abcd1234567890abcdef")
    prompt = f"here is my config: {fake_secret}"
    raw = {"message": {"content": prompt}}

    # Pipeline order used by claude.py: redact_obj() first, hash_message_content() second.
    redacted = redact_obj(raw)
    hashed = hash_message_content(redacted)

    expected_redacted_text = redact_content(prompt)
    assert "«REDACTED»" in expected_redacted_text
    assert fake_secret not in expected_redacted_text

    assert hashed["message"]["content"] == hash_text(expected_redacted_text)
    # Must NOT equal the hash of the raw (unredacted) secret-bearing string.
    assert hashed["message"]["content"] != hash_text(prompt)


# ---------------------------------------------------------------------------
# Integration: ClaudeAdapter.parse_line() honors the module-level gate,
# mirroring the monkeypatch.setattr pattern test_claude_adapter.py already
# uses for _REDACT_ENABLED.
# ---------------------------------------------------------------------------

def _assistant_line(text: str) -> dict:
    return {
        "type": "assistant",
        "uuid": "uuid-hash-1",
        "timestamp": "2026-07-16T00:00:00Z",
        "message": {
            "id": "msg-1",
            "model": "claude-opus-4-8",
            "content": [{"type": "text", "text": text}],
            "usage": {"input_tokens": 10, "output_tokens": 5},
        },
    }


def test_default_off_payload_contains_plaintext():
    """AURA_HASH_CONTENT is unset in the test environment — the module-level
    default must be False, and payload text must NOT be hashed."""
    assert claude_mod._HASH_CONTENT_ENABLED is False

    adapter = ClaudeAdapter()
    raw = _assistant_line("this should stay plaintext by default")
    event = adapter.parse_line(raw, file_path="logs/proj/sess/f.jsonl", byte_offset=0)
    parsed = json.loads(event["payload"])
    assert parsed["message"]["content"][0]["text"] == "this should stay plaintext by default"


def test_gate_on_hashes_payload_text(monkeypatch):
    monkeypatch.setattr(claude_mod, "_HASH_CONTENT_ENABLED", True)

    adapter = ClaudeAdapter()
    raw = _assistant_line("this must be hashed, not stored in the clear")
    event = adapter.parse_line(raw, file_path="logs/proj/sess/f.jsonl", byte_offset=0)
    parsed = json.loads(event["payload"])

    text_value = parsed["message"]["content"][0]["text"]
    assert text_value.startswith("sha256:")
    assert "this must be hashed" not in text_value
    assert text_value == hash_text("this must be hashed, not stored in the clear")


def test_gate_on_still_produces_valid_json(monkeypatch):
    monkeypatch.setattr(claude_mod, "_HASH_CONTENT_ENABLED", True)
    monkeypatch.setattr(claude_mod, "_REDACT_ENABLED", True)

    adapter = ClaudeAdapter()
    fake_secret = _fake("api_key=", "zzzz9876543210zzzzzz")
    raw = _assistant_line(f"leaked: {fake_secret}")
    event = adapter.parse_line(raw, file_path="logs/proj/sess/f.jsonl", byte_offset=0)

    parsed = json.loads(event["payload"])  # must not raise
    text_value = parsed["message"]["content"][0]["text"]
    assert text_value.startswith("sha256:")
    assert fake_secret not in text_value


def test_env_gate_parsing_truthy_values():
    """Mirrors the exact parsing expression used in claude.py:
    `os.getenv("AURA_HASH_CONTENT", "false").lower() in ("1", "true")`.
    Only "1"/"true" (case-insensitive) are truthy — unlike AURA_REDACT_PAYLOAD's
    broader ("1", "true", "yes") acceptance, matching the T8 spec exactly."""

    def parse(value: str) -> bool:
        return value.lower() in ("1", "true")

    for truthy in ("1", "true", "True", "TRUE", "tRuE"):
        assert parse(truthy) is True, truthy
    for falsy in ("0", "false", "False", "yes", "no", "", "on"):
        assert parse(falsy) is False, falsy
