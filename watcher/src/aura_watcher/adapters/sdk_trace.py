"""Adapter for external SDK agent traces (Task 1).

Trace format
------------
One JSON object per line, written by an external tracer. Every event carries:

  * ``t``    — float seconds elapsed from run start
  * ``turn`` — int turn counter
  * ``kind`` — one of {run_start, message, thinking, tool_use, tool_result,
               text, result, interrupted, run_end}

There are **no** per-line ISO timestamps and **no** per-line uuid, so this
adapter synthesises both:

``uuid``
    ``f"{session_id}:{byte_offset}"`` — deterministic and keyed on the byte
    offset of the line. Because the byte-offset checkpoint means settled bytes
    are never re-read, this freezes the first-written row identity and makes
    backfill re-reads idempotent (PK ``(tenant_id, uuid)`` with
    ``ON CONFLICT DO NOTHING``).

``ts``
    ``anchor_ts`` + ``t`` seconds. The trace has no wall-clock field, so ingest
    computes the anchor once per file (``mtime_at_first_read - t_of_last_line``,
    S3), persists it in the checkpoint and sets ``adapter.anchor_ts`` before
    parsing. Re-reads and later appends therefore keep the same ts per line.

``event_type`` / ``message_id``
    Mapped onto the shape downstream dbt expects rather than left faithful to
    ``kind``. ``message`` and the cost-bearing ``result`` surface as
    ``event_type='assistant'`` with a non-null ``message_id`` (the only shape
    ``stg_assistant_messages`` admits, hence the only path to ``dim_sessions`` /
    ``fact_model_calls``). ``result`` reuses the last ``message``'s
    ``message_id`` so the verbatim run cost merges onto the final assistant turn.
    All other kinds stay faithful markers with ``message_id=None``.

State
-----
The adapter is **stateful per file**: it remembers ``self._model``,
``self._max_turns`` and ``self._label`` from the ``run_start`` line so later
events can be attributed to the run's model. Ingest caches one instance per
file and, on a fresh instance with offset > 0, primes it by replaying the
lines before the offset (S2).

The Claude path is unaffected: it relies on the ``source`` column default
('claude') and a NULL ``reported_cost_usd``; only this adapter sets
``source='sdk_trace'`` and populates ``reported_cost_usd`` on the single
cost-bearing ``result`` event.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

from aura_watcher.redact import redact_enabled, redact_obj

from .base import Adapter, session_id_from_path

_log = logging.getLogger(__name__)

# Mirror claude.py's redaction toggle exactly so behaviour is consistent across
# adapters. Default is redact-on; set AURA_REDACT_PAYLOAD=false/0/no/off to disable.
_REDACT_ENABLED = redact_enabled()


class SdkTraceAdapter(Adapter):
    """Parse external SDK trace JSONL into ``raw_events`` rows.

    Returns a FIXED-SHAPE dict on every call (identical key set, ``None`` where
    a value is absent); ``lake.coerce_row`` fills the remaining columns.
    """

    def __init__(self) -> None:
        # Set by ingest before parsing (S3); None only outside ingest (tests).
        self.anchor_ts: datetime | None = None
        # Per-file run state, populated from the run_start line.
        self._model: str | None = None
        self._max_turns: int | None = None
        self._label: str | None = None
        self._cwd: str | None = None
        # uuid of the most recent assistant 'message' event this pass — the
        # cost-bearing 'result' event reuses it so the verbatim run cost merges
        # onto the final assistant turn (see parse_line).
        self._last_assistant_message_id: str | None = None

    def parse_line(self, raw: dict, file_path: str, byte_offset: int) -> dict | None:
        # Defensive: non-dict JSON values (list/str/int/None) must not crash.
        # Mirror ClaudeAdapter — drop with a warning so the line is observable.
        if not isinstance(raw, dict):
            _log.warning(
                "[sdk_trace] dropping non-dict JSON line from %s (type=%s)",
                file_path,
                type(raw).__name__,
            )
            return None

        kind = raw.get("kind")

        # Capture run-level context from run_start so later events inherit it.
        if kind == "run_start":
            self._model = raw.get("model")
            self._max_turns = raw.get("max_turns")
            self._label = raw.get("label")
            self._cwd = raw.get("cwd")

        session_id = session_id_from_path(file_path)
        uuid = f"{session_id}:{byte_offset}"

        anchor = self.anchor_ts or datetime.now(timezone.utc)
        try:
            ts = anchor + timedelta(seconds=float(raw.get("t") or 0))
        except (TypeError, ValueError):
            ts = anchor

        # event_type mapping. Downstream, stg_assistant_messages gates on
        # `event_type='assistant' AND message_id IS NOT NULL` — that gate is the
        # ONLY path by which a session reaches int_turns -> fact_turns ->
        # dim_sessions and fact_model_calls. So the assistant 'message' events
        # and the cost-bearing 'result' event must surface as 'assistant' with a
        # non-null message_id; every other kind stays a faithful marker with a
        # NULL message_id (mirroring Claude, where non-assistant events carry no
        # message_id). A missing kind degrades to a stable sentinel, never dropped.
        message_id: str | None = None
        if kind == "message":
            event_type = "assistant"
            message_id = uuid
            self._last_assistant_message_id = uuid
        elif kind == "result":
            event_type = "assistant"
            # Merge the run's verbatim cost onto the final assistant turn by
            # reusing the last message's message_id: stg_assistant_messages
            # dedups by message_id (keep latest ts/byte_offset), so the result
            # row replaces the last message row -> turn_count stays == number of
            # assistant messages and the cost lands on exactly one turn. With no
            # prior message this pass (e.g. a result-only incremental read) the
            # result becomes its own turn.
            message_id = self._last_assistant_message_id or uuid
        else:
            event_type = kind if kind is not None else "unknown"

        # project_id: best-effort from the run's cwd (seen on run_start). If we
        # never saw run_start this pass, degrade to 'unknown'.
        project_id = self._cwd if self._cwd else "unknown"

        model = self._model

        # Token / cost extraction — only the result event is cost-bearing.
        input_tokens = None
        output_tokens = None
        cache_creation_input_tokens = None
        cache_read_input_tokens = None
        ephemeral_5m_input_tokens = None
        ephemeral_1h_input_tokens = None
        reported_cost_usd = None

        if kind == "result":
            raw_result = raw.get("raw") or {}
            if isinstance(raw_result, dict):
                reported_cost_usd = raw_result.get("total_cost_usd")
                usage = raw_result.get("usage") or {}
                if isinstance(usage, dict):
                    input_tokens = usage.get("input_tokens")
                    output_tokens = usage.get("output_tokens")
                    cache_creation_input_tokens = usage.get("cache_creation_input_tokens")
                    cache_read_input_tokens = usage.get("cache_read_input_tokens")
                    ephemeral_5m_input_tokens = usage.get("ephemeral_5m_input_tokens")
                    ephemeral_1h_input_tokens = usage.get("ephemeral_1h_input_tokens")

        # M2: redact the object, then serialise (same transform as redact.redact_payload).
        payload = json.dumps(redact_obj(raw) if _REDACT_ENABLED else raw)

        # FIXED-SHAPE dict — identical key set on every call (None where N/A).
        # Every key is a real raw_events column (the INSERT uses dict keys as
        # the column list).
        return {
            "uuid": uuid,
            "session_id": session_id,
            "project_id": project_id,
            "agent": "sdk",
            "event_type": event_type,
            "ts": ts,
            "file_path": file_path,
            "byte_offset": byte_offset,
            "message_id": message_id,
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_creation_input_tokens": cache_creation_input_tokens,
            "ephemeral_5m_input_tokens": ephemeral_5m_input_tokens,
            "ephemeral_1h_input_tokens": ephemeral_1h_input_tokens,
            "cache_read_input_tokens": cache_read_input_tokens,
            "source": "sdk_trace",
            "reported_cost_usd": reported_cost_usd,
            "payload": payload,
        }

