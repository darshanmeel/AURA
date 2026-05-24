import json
import os
from datetime import datetime
from aura_watcher.redact import redact_content

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
        
        # Extract session_id from sessionId or fallback to file_path
        session_id = raw.get("sessionId")
        if not session_id:
            parts = file_path.split(os.sep)
            session_id = parts[-2] if len(parts) >= 2 else "unknown"

        project_id = "unknown"
        parts = file_path.replace('/', os.sep).split(os.sep)
        try:
            if "projects" in parts:
                idx = parts.index("projects")
                if len(parts) > idx + 1:
                    encoded_proj = parts[idx + 1]
                    decoded_proj = encoded_proj.replace("--", "\x00").replace("-", "/").replace("\x00", "-")
                    project_id = decoded_proj
            elif len(parts) >= 2:
                # Fallback: if not in a "projects" folder, try to use the parent directory
                project_id = parts[-2]
        except Exception:
            pass

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
            "project_id": project_id,
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
            "payload": redact_content(json.dumps(raw))
        }

    def parse_skills(self, raw: dict, file_path: str) -> list[dict]:
        if raw.get("type") != "attachment":
            return []
        
        attachment = raw.get("attachment")
        if not attachment or attachment.get("type") != "skills":
            return []
        
        session_id = raw.get("sessionId")
        if not session_id:
            parts = file_path.split(os.sep)
            session_id = parts[-2] if len(parts) >= 2 else "unknown"

        names = attachment.get("names", [])
        is_initial = attachment.get("isInitial", False)
        
        skills = []
        for name in names:
            skills.append({
                "tenant_id": "local",
                "session_id": session_id,
                "skill_name": name,
                "is_initial": is_initial
            })
            
        return skills

