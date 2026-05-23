import json
import os
from datetime import datetime

class ClaudeAdapter:
    MODEL_CONTEXT_WINDOWS = {
        "claude-3-5-sonnet-20241022": 200000,
        "claude-3-opus-20240229": 200000,
        "claude-3-5-haiku-20241022": 200000,
        "claude-opus-4-7": 200000,
        "claude-sonnet-4-6": 200000,
        "claude-haiku-4-5-20251001": 200000,
        "<synthetic>": 200000,
    }

    def parse_line(self, raw: dict, file_path: str, byte_offset: int) -> dict | None:
        uuid = raw.get("uuid")
        ts = raw.get("timestamp") or raw.get("ts")
        
        # Schema requires uuid and ts to be NOT NULL
        if not uuid or not ts:
            return None

        event_type = raw.get("type", "unknown")
        message = raw.get("message", {}) or {}
        usage = message.get("usage", {}) or {}
        model = message.get("model") or raw.get("model")
        
        # Extract session_id from sessionId or fallback to file_path (assuming .../session_id/log.jsonl)
        session_id = raw.get("sessionId")
        if not session_id:
            parts = file_path.split(os.sep)
            session_id = parts[-2] if len(parts) >= 2 else "unknown"

        context_pct = None
        if usage and model:
            window = self.MODEL_CONTEXT_WINDOWS.get(model, 200000)
            tokens = (
                usage.get("input_tokens", 0) +
                usage.get("cache_creation_input_tokens", 0) +
                usage.get("cache_read_input_tokens", 0)
            )
            context_pct = tokens / window

        cache_creation = usage.get("cache_creation", {}) or {}

        return {
            "uuid": uuid,
            "session_id": session_id,
            "agent": "claude",
            "event_type": event_type,
            "ts": ts,
            "file_path": file_path,
            "byte_offset": byte_offset,
            "parent_uuid": raw.get("parentUuid"),
            "request_id": raw.get("requestId"),
            "message_id": message.get("id"),
            "is_sidechain": raw.get("isSidechain", False),
            "stop_reason": message.get("stop_reason"),
            "cwd": raw.get("cwd"),
            "git_branch": raw.get("gitBranch"),
            "claude_version": raw.get("version"),
            "model": model,
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
            "ephemeral_5m_input_tokens": cache_creation.get("ephemeral_5m_input_tokens"),
            "ephemeral_1h_input_tokens": cache_creation.get("ephemeral_1h_input_tokens"),
            "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
            "context_pct": context_pct,
            "payload": json.dumps(raw)
        }

