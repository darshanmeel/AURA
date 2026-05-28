import json
import os
from aura_watcher.adapters.claude import ClaudeAdapter

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
    # Path with session_abc
    file_path = os.path.join("logs", "claude", "session_abc", "log.jsonl")
    event = adapter.parse_line(raw_line, file_path=file_path, byte_offset=0)
    assert event["uuid"] == "uuid-1"
    assert event["session_id"] == "session_abc"
    assert event["input_tokens"] == 100
    # (100 + 10 + 200) / 200000 = 0.00155
    assert event["context_pct"] == 0.00155

