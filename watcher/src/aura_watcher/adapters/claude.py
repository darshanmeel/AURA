import json
import logging
import os

from aura_watcher.redact import hash_message_content, redact_obj

from .base import Adapter

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Redaction toggle
# Set AURA_REDACT_PAYLOAD=false (or 0 / no) to pass raw payloads through
# unchanged.  Useful when you trust your environment and want to preserve
# legitimate base64 content (screenshots, attachments).  Default is true.
# ---------------------------------------------------------------------------
_REDACT_ENABLED = os.getenv("AURA_REDACT_PAYLOAD", "true").lower() in ("1", "true", "yes")

# ---------------------------------------------------------------------------
# T8: content-hash toggle (default OFF).
# Set AURA_HASH_CONTENT=1/true (case-insensitive) to replace conversational
# text ($.message.content / $.message.content[N].text) with sha256:<hex>
# markers at ingest time, making user_prompt / assistant_response /
# prompt_text_200 / summary_200 cryptographically non-recoverable downstream
# (see the T8 header block in redact.py for the full rationale). Read ONCE
# at process startup — never re-checked per event. Applies to NEW ingests
# only; existing raw_events rows are not retroactively rewritten. Enabling
# this disables the session replay / conversation view for any events
# ingested while it is on, since the underlying text is gone, not just masked
# in the UI.
# ---------------------------------------------------------------------------
_HASH_CONTENT_ENABLED = os.getenv("AURA_HASH_CONTENT", "false").lower() in ("1", "true")

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
    "claude-opus-4-8": 200000,
    "claude-opus-4-7": 200000,
    "claude-sonnet-4-6": 200000,
    "claude-haiku-4-5-20251001": 200000,
    "<synthetic>": 200000,
}

_overrides_raw = os.getenv("AURA_MODEL_WINDOWS_JSON", "")
if _overrides_raw:
    try:
        _default_windows.update(json.loads(_overrides_raw))
    except Exception as _e:
        _log.warning("[adapter] failed to parse AURA_MODEL_WINDOWS_JSON: %s", _e)

# Tracks models we have already warned about so each unknown model logs once.
_warned_models: set = set()

# Unknown models queued for watcher_errors. Drained by dbt_worker each cycle.
# Set union with _warned_models keeps the log-once invariant across drains.
_unknown_models_pending: set = set()

# RC3: control records that legitimately have no uuid/ts. Dropping them is
# correct; use DEBUG (not WARNING) so the log is not spammed on every file.
# Exported so process_file can import and use the same set for counter
# classification (dropped_known vs dropped_unknown).
KNOWN_NON_EVENT_TYPES: frozenset = frozenset({
    "last-prompt",
    "mode",
    "permission-mode",
    "file-history-snapshot",
    "ai-title",
    "queue-operation",
    "summary",
})


class ClaudeAdapter(Adapter):
    MODEL_CONTEXT_WINDOWS = _default_windows

    def parse_line(self, raw: dict, file_path: str, byte_offset: int) -> dict | None:
        # W-M7: non-dict JSON values (list, str, int, None) must not crash the
        # adapter.  JSONL lines that are valid JSON but not objects are dropped
        # with a warning so they are observable without propagating AttributeError.
        if not isinstance(raw, dict):
            _log.warning(
                "[adapter] dropping non-dict JSON line from %s (type=%s)",
                file_path,
                type(raw).__name__,
            )
            return None

        uuid = raw.get("uuid")
        ts = raw.get("timestamp") or raw.get("ts")

        # Schema requires uuid and ts to be NOT NULL; drop the line but make
        # the drop observable so silent data loss is diagnosable.
        # RC3: known control-record types (no uuid/ts by design) use DEBUG so
        # the log is not spammed; unknown missing-field cases stay at WARNING.
        if not uuid or not ts:
            missing = [f for f, v in (("uuid", uuid), ("ts", ts)) if not v]
            if raw.get("type") in KNOWN_NON_EVENT_TYPES:
                _log.debug(
                    "[adapter] dropping known non-event control record from %s (type=%s)",
                    file_path,
                    raw.get("type"),
                )
            else:
                # Fix 2 (2026-07-13): was WARNING, firing per-line for every
                # non-control-record line missing uuid/ts (e.g. every line of
                # a workflow journal file) and flooding synchronous Docker log
                # I/O during backfill. DEBUG keeps the drop observable without
                # the flood; still classified as dropped_unknown in the
                # per-file counters (ingest_file_stats) for real visibility.
                _log.debug(
                    "[adapter] dropping line from %s: missing required field(s) %s",
                    file_path,
                    missing,
                )
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
                    # ASSUMPTION: only the first path segment after "projects/" is
                    # decoded.  Claude Code encodes the project path as a single
                    # directory name using "--" as a dash literal and "-" as a
                    # separator.  Multi-segment paths (e.g. "a/b/c") are collapsed
                    # into one directory entry; this decoder recovers only that one
                    # entry and is therefore lossy for nested paths.
                    decoded_proj = encoded_proj.replace("--", "\x00").replace("-", "/").replace("\x00", "-")
                    project_id = decoded_proj
                    # Warn once when the decoded value doesn't look like a path
                    # (no slash and longer than a bare directory name hint that
                    # the encoding convention may have changed).
                    if "/" not in decoded_proj and len(decoded_proj) > 80:
                        _log.warning(
                            "[adapter] project_id decode looks unexpected (no '/' in '%s'); "
                            "encoding convention may have changed for file %s",
                            decoded_proj[:40],
                            file_path,
                        )
            elif len(parts) >= 2:
                # Fallback: not inside a "projects" folder; use parent directory.
                project_id = parts[-2]
        except Exception:
            pass

        context_pct = None
        if usage and model:
            if model not in self.MODEL_CONTEXT_WINDOWS and model not in _warned_models:
                _log.warning(
                    "[adapter] unknown model context window for '%s', defaulting to 200000",
                    model,
                )
                _warned_models.add(model)
                _unknown_models_pending.add(model)  # surfaced to watcher_errors by dbt_worker
            window = self.MODEL_CONTEXT_WINDOWS.get(model, 200000)
            tokens = (
                usage.get("input_tokens", 0) +
                usage.get("cache_creation_input_tokens", 0) +
                usage.get("cache_read_input_tokens", 0)
            )
            context_pct = tokens / window

        cache_creation = usage.get("cache_creation", {}) or {}

        # RC2 + T8: build the payload object in two ordered steps — redact
        # first (secret/base64 scrubbing over the WHOLE object), then hash
        # (T8's targeted $.message.content replacement) — before the single
        # json.dumps() at the end. See the field comment below and redact.py's
        # T8 header block for why this ordering and this callsite is the one
        # choke point covering all four downstream-masked columns.
        payload_obj = redact_obj(raw) if _REDACT_ENABLED else raw
        if _HASH_CONTENT_ENABLED:
            payload_obj = hash_message_content(payload_obj)

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
            # RC2: redact_obj() is called on the raw Python dict BEFORE
            # json.dumps() so that json.dumps() does all escaping after
            # redaction. The previous pattern (redact_content(json.dumps(raw)))
            # operated on the already-escaped JSON string and caused
            # BASE64_REGEX to match across JSON escape sequences (e.g. the 'n'
            # of '\n' followed by 200+ alphanum chars), replacing them with
            # '<base64:N bytes>' and leaving a dangling backslash — an invalid
            # JSON escape that broke DuckDB's json_extract in dbt.
            "payload": json.dumps(payload_obj)
        }

    def parse_session_attributes(self, raw: dict, file_path: str) -> dict | None:
        """Extract session-level attributes from ai-title / permission-mode / mode records.

        These control records have no uuid/ts and are dropped by parse_line.
        This separate path captures them for upsert into session_meta.

        Returns a dict with 'session_id' plus one of:
          'title'           (from ai-title)
          'permission_mode' (from permission-mode)
          'mode'            (from mode)
        or None if the record is not one of these three types.
        """
        if not isinstance(raw, dict):
            return None

        event_type = raw.get("type")
        if event_type not in ("ai-title", "permission-mode", "mode"):
            return None

        # Resolve session_id. Real JSONL layout is <project_dir>/<session_id>.jsonl,
        # so the fallback is the filename stem (matching on_created and
        # backfill_session_attributes), NOT the parent dir.
        session_id = raw.get("sessionId")
        if not session_id:
            session_id = os.path.splitext(os.path.basename(file_path))[0] or "unknown"

        if event_type == "ai-title":
            title = raw.get("aiTitle")
            if not isinstance(title, str) or not title:
                return None
            return {"session_id": session_id, "title": title}

        if event_type == "permission-mode":
            perm = raw.get("permissionMode")
            if not isinstance(perm, str) or not perm:
                return None
            return {"session_id": session_id, "permission_mode": perm}

        if event_type == "mode":
            mode = raw.get("mode")
            if not isinstance(mode, str) or not mode:
                return None
            return {"session_id": session_id, "mode": mode}

        return None  # unreachable; satisfies linter

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

