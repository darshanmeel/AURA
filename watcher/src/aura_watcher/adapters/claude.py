import json
import json as _json
import os
import os as _os
from datetime import datetime
from aura_watcher.redact import redact_content

# ---------------------------------------------------------------------------
# Redaction toggle
# Set AURA_REDACT_PAYLOAD=false (or 0 / no) to pass raw payloads through
# unchanged.  Useful when you trust your environment and want to preserve
# legitimate base64 content (screenshots, attachments).  Default is true.
# ---------------------------------------------------------------------------
_REDACT_ENABLED = _os.getenv("AURA_REDACT_PAYLOAD", "true").lower() in ("1", "true", "yes")

# ---------------------------------------------------------------------------
# Model context windows
# Defaults cover every Anthropic model shipped as of 2026-05.  To add a new
# model without rebuilding the container, set AURA_MODEL_WINDOWS_JSON to a
# JSON object of {model_id: context_window_tokens}, e.g.:
#   AURA_MODEL_WINDOWS_JSON='{"claude-opus-5-20260601": 1000000}'
# ---------------------------------------------------------------------------
_default_windows: dict = {
    "claude-3-5-sonnet-20241022": 200000,
    "claude-3-opus-20240229": 200000,
    "claude-3-5-haiku-20241022": 200000,
    "claude-opus-4-7": 200000,
    "claude-sonnet-4-6": 200000,
    "claude-haiku-4-5-20251001": 200000,
    "<synthetic>": 200000,
}

_overrides_raw = _os.getenv("AURA_MODEL_WINDOWS_JSON", "")
if _overrides_raw:
    try:
        _default_windows.update(_json.loads(_overrides_raw))
    except Exception as _e:
        print(f"[adapter] Warning: failed to parse AURA_MODEL_WINDOWS_JSON: {_e}")

# Tracks models we have already warned about so each unknown model logs once.
_warned_models: set = set()


class ClaudeAdapter:
    MODEL_CONTEXT_WINDOWS = _default_windows

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
            if model not in self.MODEL_CONTEXT_WINDOWS and model not in _warned_models:
                print(f"[adapter] Unknown model context window for '{model}', defaulting to 200000")
                _warned_models.add(model)
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
            "payload": redact_content(json.dumps(raw)) if _REDACT_ENABLED else json.dumps(raw)
        }

    def parse_skills(self, raw: dict, file_path: str) -> list[dict]:
        """Extract skill registrations from an attachment event.

        Claude Code's JSONL ships skill information in attachment events.
        Three shapes seen in the wild:
          1) `attachment.type == "skills"` with a `names` array.
          2) `attachment.type == "skill_listing"` with a `content` string
             that is a markdown bullet list (`- plugin:skill: desc`).
          3) `attachment.type == "invoked_skills"` with a `skills` array
             of `{name, path, content}` objects. This is the dominant
             shape on current Claude Code builds — `skill_listing` does
             not appear in our logs, but `invoked_skills` does, with
             every actually-invoked skill carrying its full prompt
             content. We persist only the name; the content stays in
             raw_events.

        is_initial defaults to True for skill_listing and invoked_skills
        because they fire near session start in practice.
        """
        if raw.get("type") != "attachment":
            return []

        attachment = raw.get("attachment")
        if not attachment:
            return []
        att_type = attachment.get("type")

        session_id = raw.get("sessionId")
        if not session_id:
            parts = file_path.split(os.sep)
            session_id = parts[-2] if len(parts) >= 2 else "unknown"

        names: list[str] = []
        is_initial = False

        if att_type == "skills":
            names = list(attachment.get("names", []))
            is_initial = bool(attachment.get("isInitial", False))
        elif att_type == "skill_listing":
            # Parse bullet-list content. Each non-empty line that starts
            # with "- " carries one skill identifier (everything before
            # the second ":" in `- plugin:skill: description`).
            content = attachment.get("content", "")
            if isinstance(content, list):
                # Defensive: some emit arrays of strings.
                content = "\n".join(c for c in content if isinstance(c, str))
            for line in (content or "").splitlines():
                line = line.strip()
                if not line.startswith("- "):
                    continue
                body = line[2:]
                # `<plugin>:<skill>: <description>` → keep `<plugin>:<skill>`
                # `<skill>: <description>`         → keep `<skill>`
                colon1 = body.find(":")
                if colon1 == -1:
                    continue
                colon2 = body.find(":", colon1 + 1)
                ident = body[:colon2] if colon2 != -1 else body[:colon1]
                ident = ident.strip()
                if ident:
                    names.append(ident)
            is_initial = True  # skill_listing fires once near session start
        elif att_type == "invoked_skills":
            # `skills` is a list of {name, path, content}. Persist names only.
            skills_arr = attachment.get("skills") or []
            for sk in skills_arr:
                if not isinstance(sk, dict):
                    continue
                name = sk.get("name")
                if isinstance(name, str) and name.strip():
                    names.append(name.strip())
            is_initial = True
        else:
            return []

        # Deduplicate within this single attachment event so the ON CONFLICT
        # primary-key check on (session, skill) doesn't get redundant rows.
        seen: set = set()
        skills: list[dict] = []
        for name in names:
            if name in seen:
                continue
            seen.add(name)
            skills.append({
                "tenant_id": "local",
                "session_id": session_id,
                "skill_name": name,
                "is_initial": is_initial,
            })
        return skills

    def parse_mcp_servers(self, raw: dict, file_path: str) -> list[dict]:
        """Extract MCP server registrations from an attachment event.

        Claude Code logs MCP-server loads as
        `attachment.type == "mcp_instructions_delta"` with `addedNames`
        like `["plugin:context7:context7"]`. We capture one row per
        (session, server) so /sessions/<id> can show which MCP surfaces
        the agent had access to in that session.
        """
        if raw.get("type") != "attachment":
            return []
        attachment = raw.get("attachment")
        if not attachment or attachment.get("type") != "mcp_instructions_delta":
            return []
        names = attachment.get("addedNames") or []
        if not names:
            return []

        session_id = raw.get("sessionId")
        if not session_id:
            parts = file_path.split(os.sep)
            session_id = parts[-2] if len(parts) >= 2 else "unknown"

        seen: set = set()
        out: list[dict] = []
        for name in names:
            if not isinstance(name, str) or not name or name in seen:
                continue
            seen.add(name)
            out.append({
                "tenant_id": "local",
                "session_id": session_id,
                "mcp_server": name,
            })
        return out

