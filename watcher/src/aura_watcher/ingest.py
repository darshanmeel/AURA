"""Ingest: logical paths (spec §2.6), file listing, incremental reads, per-file
parsing into in-memory buffers, and the flush to the lake + SQLite checkpoint.

Everything here runs on the single ingest thread; no DuckDB connection is
opened outside ``flush`` (S9, S11).
"""

import glob
import hashlib
import json
import os
import queue
import traceback
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from aura_watcher import lake, state
from aura_watcher.adapters.base import session_id_from_path
from aura_watcher.adapters.claude import KNOWN_NON_EVENT_TYPES, ClaudeAdapter
from aura_watcher.adapters.sdk_trace import SdkTraceAdapter
from aura_watcher.session_meta import session_meta_row

HEAD_LEN = 512
MAX_BUFFER_BYTES = 64 * 1024 * 1024


# --------------------------------------------------------------------------- paths

def make_roots(logs_dir: str, extra_dirs: list[str]) -> list[tuple[str, str]]:
    """``[("claude", logs_dir), ("trace1", first extra dir), ...]``; the
    numbering follows the env var order, so a missing dir never shifts it."""
    return [("claude", logs_dir)] + [(f"trace{i}", d) for i, d in enumerate(extra_dirs, 1)]


def _norm(p: str) -> str:
    return os.path.abspath(p).replace("\\", "/").rstrip("/")


def logical_path(path: str, roots) -> str | None:
    p = _norm(path)
    for prefix, root in roots:
        r = _norm(root) + "/"
        if os.path.normcase(p).startswith(os.path.normcase(r)):
            return f"{prefix}/{p[len(r):]}"
    return None


def physical_path(logical: str, roots) -> str:
    prefix, _, rel = logical.partition("/")
    return os.path.join(dict(roots)[prefix], *rel.split("/"))


def is_workflow_journal(path: str) -> bool:
    """Subagent workflow journals (``**/subagents/workflows/**/journal.jsonl``)
    carry no uuid/ts, so every line would be read and dropped."""
    p = path.replace("\\", "/")
    return p.endswith("/journal.jsonl") and "/subagents/workflows/" in p


def list_files(roots) -> list[tuple[str, int, float]]:
    """``(logical, size, mtime)`` of every transcript, oldest mtime first, so the
    ingested frontier (raw_events age) advances truthfully during a backfill."""
    found: dict[str, tuple[str, int, float]] = {}
    for _, root in roots:
        if not os.path.isdir(root):
            continue
        for f in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True):
            lp = logical_path(f, roots)
            if lp is None or lp in found or is_workflow_journal(lp):
                continue
            try:
                st = os.stat(f)
            except OSError:  # ephemeral workflow files vanish between glob and stat
                continue
            found[lp] = (lp, st.st_size, st.st_mtime)
    return sorted(found.values(), key=lambda t: t[2])


# --------------------------------------------------------------------------- reading

def _sha1(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()


def needs_read(size: int, head: bytes, cp: dict | None) -> tuple[int, bool]:
    """``(start_offset, reset)``. A file smaller than its checkpoint, or whose
    first bytes changed, was truncated or rotated: re-read from 0 (Q1)."""
    if cp is None:
        return 0, False
    off = cp["last_offset"]
    if size < off or (cp.get("head_hash") and _sha1(head[: cp["head_len"]]) != cp["head_hash"]):
        return 0, True
    return off, False


def read_new_lines(path: str, offset: int):
    """Yield ``(line_offset, line_bytes)`` from ``offset``. A final chunk with no
    newline is yielded only if it is complete JSON; otherwise reading stops
    there so the torn line is re-read once Claude finishes writing it (M1)."""
    with open(path, "rb") as f:
        f.seek(offset)
        pos = offset
        for line in f:
            if not line.endswith(b"\n"):
                try:
                    json.loads(line)
                except ValueError:
                    return
            yield pos, line
            pos += len(line)


def adapter_for_file(path: str):
    """SDK traces are JSON objects with a ``kind`` key on the first non-empty
    line; anything else (including unreadable files) is a Claude transcript."""
    try:
        with open(path, "rb") as f:
            for line in f:
                if line.strip():
                    first = json.loads(line)
                    return SdkTraceAdapter() if isinstance(first, dict) and "kind" in first else ClaudeAdapter()
    except (OSError, ValueError):
        pass
    return ClaudeAdapter()


def sdk_anchor(path: str) -> str:
    """S3: the trace only has ``t`` (seconds since run start), so the wall-clock
    anchor is ``mtime - t_of_last_line``, computed once at the first read."""
    mtime = os.path.getmtime(path)
    last_t = 0.0
    with open(path, "rb") as f:
        for line in f:
            try:
                t = json.loads(line).get("t")
            except (ValueError, AttributeError):
                continue
            if isinstance(t, (int, float)):
                last_t = float(t)
    anchor = datetime.fromtimestamp(mtime, UTC) - timedelta(seconds=last_t)
    return anchor.replace(tzinfo=None).isoformat()


# --------------------------------------------------------------------------- context

def new_context(con, roots, lake_dir: str, scratch: str, flush_max_rows: int = 20000):
    return SimpleNamespace(
        con=con, roots=roots, lake_dir=lake_dir, scratch=scratch, flush_max_rows=flush_max_rows,
        checkpoints=state.load_checkpoints(con), stats=state.load_file_stats(con),
        pending={}, buffers={t: [] for t in lake.SCHEMAS}, buffer_bytes=0, adapters={},
        errors=queue.Queue(), errors_since_start=0, last_sweep=[],
        last_flush_at=None, last_flush_rows={}, max_event_ts=None,
    )


def push_error(q, source: str, file_path: str | None, message: str, stack: str | None = None) -> None:
    print(f"[{source}] {file_path or ''} {message}", flush=True)
    q.put({"ts": lake.utcnow(), "source": source, "file_path": file_path,
           "error_message": message, "stack_trace": stack})


def _new_stats(reset: bool) -> dict:
    return {"reset": reset, "lines_total": 0, "events_kept": 0, "dropped_known": 0,
            "dropped_unknown": 0, "parse_errors": 0, "last_error": None}


def _merge_stats(old: dict | None, new: dict) -> dict:
    if old is None or new["reset"]:
        return dict(new)
    out = {c: (old.get(c) or 0) + new[c] for c in state.STAT_COLS}
    out["reset"] = old.get("reset", False)
    out["last_error"] = new["last_error"] or old.get("last_error")
    return out


def _stash(ctx, logical, offset, last_uuid, head, anchor, stats) -> None:
    prev = ctx.pending.get(logical)
    ctx.pending[logical] = {
        "last_offset": offset, "head_len": len(head), "head_hash": _sha1(head),
        "last_line_uuid": last_uuid, "sdk_anchor_ts": anchor,
        "stats": _merge_stats(prev["stats"] if prev else None, stats),
    }


def _buffered_rows(ctx) -> int:
    return sum(len(rows) for rows in ctx.buffers.values())


def _event_ts(raw: dict):
    return raw.get("timestamp") or lake.utcnow()


# --------------------------------------------------------------------------- processing

def process_file(ctx, logical: str) -> None:
    try:
        _process(ctx, logical, physical_path(logical, ctx.roots))
    except Exception as e:
        push_error(ctx.errors, "process_file", logical, str(e), traceback.format_exc())


def _process(ctx, logical: str, phys: str) -> None:
    try:
        size = os.path.getsize(phys)
        with open(phys, "rb") as f:
            head = f.read(HEAD_LEN)
    except FileNotFoundError:
        return
    prev = ctx.pending.get(logical) or ctx.checkpoints.get(logical)
    offset, reset = needs_read(size, head, prev)
    if offset == size and not reset:
        return

    if prev is None:
        meta = session_meta_row(session_id_from_path(logical), phys, logical)
        ctx.buffers["session_meta"].append(lake.coerce_row("session_meta", meta))

    adapter = None if reset else ctx.adapters.get(logical)
    anchor = prev.get("sdk_anchor_ts") if prev and not reset else None
    if adapter is None:
        adapter = adapter_for_file(phys)
        ctx.adapters[logical] = adapter
        if isinstance(adapter, SdkTraceAdapter):
            anchor = anchor or sdk_anchor(phys)
            adapter.anchor_ts = datetime.fromisoformat(anchor).replace(tzinfo=UTC)
            if offset > 0:
                _prime(adapter, phys, logical, offset)

    stats = _new_stats(reset)
    last_uuid = prev.get("last_line_uuid") if prev and not reset else None
    attrs: dict = {}
    attrs_sid = None
    pos = offset
    for line_off, line in read_new_lines(phys, offset):
        pos = line_off + len(line)
        if not line.strip():
            continue
        stats["lines_total"] += 1
        try:
            raw = json.loads(line)
            ev = adapter.parse_line(raw, logical, line_off)
            if ev:
                row = lake.coerce_row("raw_events", {"tenant_id": "local", "source": "claude", **ev})
                ctx.buffers["raw_events"].append(row)
                ctx.buffer_bytes += len(row["payload"])
                last_uuid = row["uuid"]
                stats["events_kept"] += 1
            elif isinstance(raw, dict) and raw.get("type") in KNOWN_NON_EVENT_TYPES:
                stats["dropped_known"] += 1
            else:
                stats["dropped_unknown"] += 1
            if isinstance(raw, dict):
                for sk in adapter.parse_skills(raw, logical):
                    ctx.buffers["raw_session_skills"].append(
                        lake.coerce_row("raw_session_skills", {**sk, "observed_at": _event_ts(raw)}))
                for mc in adapter.parse_mcp_servers(raw, logical):
                    ctx.buffers["raw_session_mcps"].append(
                        lake.coerce_row("raw_session_mcps", {**mc, "first_seen_at": _event_ts(raw)}))
                a = adapter.parse_session_attributes(raw, logical)
                if a:
                    attrs_sid = a.pop("session_id", None) or attrs_sid
                    attrs.update(a)
        except Exception as e:
            stats["parse_errors"] += 1
            stats["last_error"] = str(e)
            push_error(ctx.errors, "process_file", logical, str(e), traceback.format_exc())

        if _buffered_rows(ctx) >= ctx.flush_max_rows or ctx.buffer_bytes >= MAX_BUFFER_BYTES:
            # S12: bound memory on a huge file by flushing mid-file.
            _stash(ctx, logical, pos, last_uuid, head, anchor, stats)
            stats = _new_stats(False)
            if not flush(ctx):
                return

    if attrs_sid and attrs:
        ctx.buffers["session_meta"].append(lake.coerce_row("session_meta", {
            "tenant_id": "local", "session_id": attrs_sid, "session_title": attrs.get("title"),
            "permission_mode": attrs.get("permission_mode"), "mode": attrs.get("mode"),
            "observed_at": lake.utcnow(),
        }))
    _stash(ctx, logical, pos, last_uuid, head, anchor, stats)


def _prime(adapter, phys: str, logical: str, offset: int) -> None:
    """S2: replay the lines before ``offset`` so a fresh SDK adapter knows the
    run's model/cwd and the last message_id; the output is discarded."""
    for line_off, line in read_new_lines(phys, 0):
        if line_off >= offset:
            break
        try:
            adapter.parse_line(json.loads(line), logical, line_off)
        except Exception:
            pass


def drain_errors(ctx) -> None:
    while True:
        try:
            err = ctx.errors.get_nowait()
        except queue.Empty:
            return
        ctx.errors_since_start += 1
        try:
            ctx.buffers["watcher_errors"].append(lake.coerce_row("watcher_errors", err))
        except ValueError:
            pass


def flush(ctx) -> bool:
    """Write every non-empty buffer to the lake, then commit the checkpoints.
    Files before checkpoint gives at-least-once delivery; on any failure the
    pending state stays and the next tick retries (C5: only the tables whose
    write failed still hold rows, and they get a new ingested_at)."""
    drain_errors(ctx)
    tables = [t for t, rows in ctx.buffers.items() if rows]
    if not tables and not ctx.pending:
        return True
    ok = True
    counts = {}
    with lake.flush_lock:
        ingested_at = lake.utcnow().strftime(lake.TS_FORMAT)
        for t in tables:
            rows = ctx.buffers[t]
            try:
                lake.write_rows(ctx.lake_dir, t, rows, ingested_at, ctx.scratch)
            except Exception as e:
                ok = False
                push_error(ctx.errors, "flush", t, str(e), traceback.format_exc())
                continue
            counts[t] = len(rows)
            if t == "raw_events":
                top = max(r["ts"] for r in rows)
                ctx.max_event_ts = max(ctx.max_event_ts or top, top)
            ctx.buffers[t] = []
    if not ok:
        return False
    try:
        state.commit_flush(ctx.con, ctx.pending)
    except Exception as e:
        push_error(ctx.errors, "flush", None, f"checkpoint commit failed: {e}", traceback.format_exc())
        return False
    now = lake.utcnow().isoformat()
    for fp, p in ctx.pending.items():
        ctx.checkpoints[fp] = {**{k: p[k] for k in state.CP_COLS if k != "last_seen_at"}, "last_seen_at": now}
        ctx.stats[fp] = _merge_stats(ctx.stats.get(fp), p["stats"])
    ctx.pending = {}
    ctx.buffer_bytes = 0
    ctx.last_flush_at = now
    ctx.last_flush_rows = {t: counts.get(t, 0) for t in lake.SCHEMAS}
    return True


def sweep(ctx, put) -> list[tuple[str, int, float]]:
    """List every file and ``put`` the ones whose size differs from their
    offset (Q1: ``!=``, so a truncated file is re-read too). The startup sweep is
    the backfill."""
    files = list_files(ctx.roots)
    for lp, size, _ in files:
        prev = ctx.pending.get(lp) or ctx.checkpoints.get(lp)
        if prev is None or prev["last_offset"] != size:
            put(lp)
    ctx.last_sweep = files
    return files
