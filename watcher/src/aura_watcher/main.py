import glob
import json
import os
import shutil
import subprocess
import threading
import time
from contextlib import nullcontext
from datetime import datetime, timezone

from watchdog.events import FileSystemEventHandler
from watchdog.observers.polling import PollingObserver

from aura_watcher.adapters.claude import (
    KNOWN_NON_EVENT_TYPES,
    ClaudeAdapter,
)
from aura_watcher.adapters.claude import (
    _unknown_models_pending as _pending_unknown,
)
from aura_watcher.adapters.sdk_trace import SdkTraceAdapter
from aura_watcher.checkpoint import CheckpointManager
from aura_watcher.coverage import write_coverage
from aura_watcher.duckdb_writer import DuckDBWriter
from aura_watcher.session_meta import (
    backfill_session_attributes,
    backfill_session_meta,
    write_session_meta,
)
from aura_watcher.snapshot import take_snapshot


def purge_duckdb_spill_dir(db_path: str) -> tuple[int, int]:
    """Delete the CONTENTS of DuckDB's on-disk spill directory (``{db_path}.tmp``)
    and return ``(files_purged, bytes_purged)``.

    TMP1 (2026-07-16): when ``temp_directory`` is unset in profiles.yml, DuckDB
    spills overflow blocks "beside the DB file" — for
    ``AURA_DB_PATH=/data/aura.duckdb`` that is ``/data/aura.duckdb.tmp/`` (see
    the dbt/profiles.yml comment documenting this default). If the watcher
    container is killed (not a clean shutdown) mid-spill, partial spill files
    are left behind in that directory. On the NEXT startup, DuckDB 1.5.4's
    temp-dir size accounting reads whatever leftover/inconsistent state is on
    disk and underflows — confirmed live: "failed to offload data block of
    size 64.0 KiB (16383.9 PiB/140.3 GiB used)" — after which EVERY subsequent
    spill is refused, producing a spurious OOM on fact_prompts even with 137G
    of real disk free. Purging the directory's contents at startup, before
    DuckDB ever opens the file and starts tracking its own spill-dir
    accounting, resets that state cleanly.

    ONLY safe to purge at startup, before ``DuckDBWriter(db_path)`` opens the
    first connection and before any worker thread starts. Once a DuckDB
    process is running against this file it OWNS this directory (actively
    reading/writing spill blocks) — purging it at any other time risks
    corrupting an in-flight query. Never call this after the watcher's first
    connection is open.

    Tolerant of a nonexistent directory (no-op — e.g. first-ever run, or a
    clean shutdown that left nothing behind) and of individual files that
    can't be removed (still-locked handle, permission error, etc.) — one
    stuck file must never abort startup or leave the purge half-done; each
    removal is wrapped in its own try/except so the walk always completes.
    """
    files_purged = 0
    bytes_purged = 0
    spill_dir = f"{db_path}.tmp"
    if os.path.isdir(spill_dir):
        # Bottom-up walk so a directory's file contents are removed before we
        # attempt to rmdir the (now hopefully empty) directory itself.
        for root, dirs, files in os.walk(spill_dir, topdown=False):
            for name in files:
                fp = os.path.join(root, name)
                try:
                    size = os.path.getsize(fp)
                    os.remove(fp)
                    files_purged += 1
                    bytes_purged += size
                except OSError as e:
                    # Never let one locked/permission-denied file crash startup —
                    # log it and keep purging the rest.
                    print(f"[startup] failed to purge spill file {fp}: {e}")
            for name in dirs:
                dp = os.path.join(root, name)
                try:
                    os.rmdir(dp)
                except OSError:
                    pass  # best-effort: non-empty (a file above failed) or in use
    print(
        f"[startup] Purged {files_purged} orphaned DuckDB spill file(s) "
        f"({bytes_purged} bytes) from {spill_dir}"
    )
    return (files_purged, bytes_purged)


def _safe_getmtime(file_path: str) -> float | None:
    """``os.path.getmtime(file_path)``, or ``None`` if the file is gone.

    Ephemeral subagent-workflow files (``.../subagents/workflows/wf_*/agent-
    *.jsonl``, ``journal.jsonl``) are created and deleted by Claude Code
    between directory enumeration (glob) and this stat call. Calling
    ``os.path.getmtime`` unguarded INSIDE a ``sorted(..., key=...)`` call
    lets a single vanished file raise ``FileNotFoundError`` mid-sort and
    abort the entire backfill — confirmed live (FileNotFoundError traceback,
    RestartCount=1, "Found 15019 files to backfill" after the Docker
    restart re-scanned everything). Any ``OSError`` here means "nothing to
    ingest" — the caller drops the file, never propagates.
    """
    try:
        return os.path.getmtime(file_path)
    except OSError:
        return None


def list_backfill_files(scan_dirs: list[str]) -> list[str]:
    """Glob every ``*.jsonl`` under ``scan_dirs``, drop workflow journals,
    dedup, and return the survivors sorted OLDEST-first by mtime (ascending).

    Oldest-first (2026-07-14 — deliberately reverses the 2026-07 newest-first
    choice): with newest-first, ``max(raw_events.ts)`` jumps to ~now as soon
    as the first (most recent) files land, even while a huge backlog of
    older files is still unprocessed. The "raw_events age = now - max(ts)"
    observability metric then reads ~0 and hides how far behind ingestion
    really is. Oldest-first makes that ingested frontier advance
    monotonically from the oldest unprocessed file, so the age metric
    truthfully counts down as backfill catches up — do not "fix" this back
    to newest-first without re-reading this comment.

    Each file's mtime is computed EXACTLY ONCE via ``_safe_getmtime`` before
    sorting (not repeatedly inside the sort comparator); a file that
    vanishes between ``glob()`` and the stat call is silently dropped from
    the list (nothing to ingest) rather than raising and killing the whole
    backfill.
    """
    globbed: list[str] = []
    for d in scan_dirs:
        globbed.extend(glob.glob(os.path.join(d, "**", "*.jsonl"), recursive=True))
    # Drop internal workflow-journal files up front — they yield zero events
    # (verified: no uuid/ts field) and would otherwise be fully
    # read+parsed+logged for nothing across thousands of files.
    globbed = [f for f in globbed if not is_workflow_journal(f)]

    # Dedup (an extra dir could overlap logs_dir), stat once per file, and
    # drop any that vanished in the meantime instead of crashing the sort.
    with_mtime: list[tuple[str, float]] = []
    for f in set(globbed):
        mtime = _safe_getmtime(f)
        if mtime is not None:
            with_mtime.append((f, mtime))

    with_mtime.sort(key=lambda pair: pair[1])  # ascending mtime = oldest first
    return [f for f, _ in with_mtime]


def filter_files_with_new_bytes(files: list[str], cp_offsets: dict[str, int]) -> list[str]:
    """Given a file list and a ``{file_path: last_offset}`` checkpoint dict,
    return only the files whose current on-disk size EXCEEDS their
    checkpointed offset — i.e. have unread bytes.

    SW1 (2026-07-16): extracted out of ``main()``'s initial-backfill
    selection so ``sweep_worker()`` (the periodic self-healing sweep) uses the
    exact same "has new bytes" definition instead of a second, potentially
    drifting, copy of this ~5-line loop. A file missing (``0`` implied via
    ``.get(f, 0)``) is treated as fully unprocessed; a file that vanishes
    between the caller's listing and this size check is silently dropped
    (nothing to ingest) rather than raising — same tolerance as
    ``list_backfill_files``.
    """
    to_process: list[str] = []
    for f in files:
        try:
            if cp_offsets.get(f, 0) < os.path.getsize(f):
                to_process.append(f)
        except OSError:
            continue
    return to_process


def is_workflow_journal(file_path: str) -> bool:
    """True for internal workflow-journal files matching
    ``**/subagents/workflows/**/journal.jsonl``.

    These are subagent-dispatch/result journals (records shaped like
    ``{"type": "started"|"result", "key": ..., "agentId": ..., "result": ...}``)
    with no ``uuid``/``ts`` field. Verified against real sample files: every
    line is dropped by ``ClaudeAdapter.parse_line`` (missing required fields),
    yielding ZERO kept events per file while still being fully read, parsed,
    and — before the log-level fix below — logged at WARNING for every line.
    Shared by the backfill file list and the live watcher handler so both
    surfaces agree on the same conservative pattern (journal.jsonl nested
    under a subagents/workflows dir; nothing broader is matched).
    """
    normalized = file_path.replace("\\", "/")
    return normalized.endswith("/journal.jsonl") and "/subagents/workflows/" in normalized


def adapter_for_file(file_path):
    """Pick the adapter for a file by sniffing its first non-empty line.

    SDK traces are JSON objects carrying a ``"kind"`` key; Claude JSONL lines
    do not. We read just the first non-empty line and:

      * JSON dict with a ``"kind"`` key   → a FRESH ``SdkTraceAdapter`` (per-run
        state must be isolated per file, so we never reuse an instance).
      * anything else (Claude lines, non-dict JSON, parse error, empty file)
        → ``ClaudeAdapter`` (the safe default; existing behaviour unchanged).

    The sniff is fully defensive — an unreadable/empty/torn first line never
    raises; it falls back to ClaudeAdapter.
    """
    try:
        with open(file_path, "rb") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    first = json.loads(line.decode("utf-8"))
                except Exception:
                    # Torn/invalid first line — default to Claude.
                    return ClaudeAdapter()
                if isinstance(first, dict) and "kind" in first:
                    return SdkTraceAdapter()
                return ClaudeAdapter()
    except Exception as e:
        print(f"[adapter_for_file] sniff failed for {file_path}: {e}; defaulting to ClaudeAdapter")
    return ClaudeAdapter()


def process_file(file_path, writer, adapter, cp_manager, *, hold_lock: bool = True):
    # _snapshot_lock now serves double duty:
    #   1. Serializes Python-level DuckDB connections (snapshot worker, writes).
    #   2. Serializes the watcher against the dbt subprocess (RC1): dbt_worker
    #      holds _snapshot_lock for the entire dbt run, so no watcher connection
    #      is open while dbt holds the file lock.
    # No deadlock risk: dbt_worker holds lock during dbt; snapshot_worker skips
    # via dbt_running; process_file blocks on get_checkpoint/write until release;
    # there is no nested lock acquisition anywhere in this call path.
    #
    # hold_lock (2026-07-13 batched-backfill fix): when True (the default —
    # used by the live watchdog handlers below), this function acquires
    # _snapshot_lock itself, exactly as before. When False, the CALLER already
    # holds _snapshot_lock for a whole batch (see run_batched_backfill()) and
    # a persistent DuckDB connection is open for that same batch — process_file
    # must NOT try to re-acquire the same non-reentrant lock here, that would
    # deadlock the calling thread against itself. nullcontext() is a no-op
    # context manager in that case, so the two `with lock_ctx:` blocks below
    # simply run unlocked (safe: the caller's lock already excludes every
    # other lock user — dbt_worker, snapshot_worker, coverage_worker, and the
    # live JSONLHandler, all of which still acquire _snapshot_lock themselves).
    lock_ctx = _snapshot_lock if hold_lock else nullcontext()
    try:
        if not os.path.exists(file_path):
            return

        # RC1: get_checkpoint opens a DuckDB connection — must be inside
        # _snapshot_lock so it cannot overlap with a dbt subprocess that has
        # the DB file lock. File read/parse happens OUTSIDE the lock (pure I/O,
        # no DuckDB involved), minimising lock hold time.
        with lock_ctx:
            checkpoint = cp_manager.get_checkpoint(file_path)

        offset = checkpoint["last_offset"]
        offset_was_reset = False

        # Spec §4 step 2: if the file is smaller than the saved offset, it was
        # rotated or truncated — reset to 0 so we re-read from the beginning.
        if os.path.getsize(file_path) < offset:
            offset = 0
            offset_was_reset = True

        last_uuid = checkpoint["last_line_uuid"]
        events = []
        skill_batches: list[list[dict]] = []
        mcp_batches: list[list[dict]] = []
        new_offset = offset  # will advance as we stream

        # Per-file accounting counters (Task 4).
        cnt_lines_total = 0
        cnt_events_kept = 0
        cnt_dropped_known = 0
        cnt_dropped_unknown = 0
        cnt_parse_errors = 0
        last_parse_error: str | None = None

        # Accumulates last-seen session attributes across the lines parsed from
        # this file.  dict.update() gives last-seen-wins within the file.
        session_attrs: dict = {}
        session_attrs_id: str | None = None

        # W-M3: stream the file line-by-line (no readlines() bulk load).
        # W-C1: track a running byte position so each line gets its own
        #        correct offset, not the batch-start offset.
        with open(file_path, 'rb') as f:
            f.seek(offset)
            for line in f:
                line_offset = new_offset          # byte position of THIS line
                new_offset += len(line)           # advance past this line

                if not line.strip():
                    continue

                cnt_lines_total += 1

                try:
                    raw = json.loads(line.decode('utf-8'))
                    event = adapter.parse_line(raw, file_path, line_offset)
                    if event:
                        events.append(event)
                        last_uuid = event["uuid"]
                        cnt_events_kept += 1
                    else:
                        # Classify the drop: known control record or unexpected.
                        if isinstance(raw, dict) and raw.get("type") in KNOWN_NON_EVENT_TYPES:
                            cnt_dropped_known += 1
                        else:
                            cnt_dropped_unknown += 1
                    try:
                        skills = adapter.parse_skills(raw, file_path)
                        if skills:
                            skill_batches.append(skills)
                    except Exception as e:
                        print(f"Error parsing skills: {e}")
                        writer.log_error('skill_parse', file_path, e)
                    try:
                        mcps = adapter.parse_mcp_servers(raw, file_path)
                        if mcps:
                            mcp_batches.append(mcps)
                    except Exception as e:
                        print(f"Error parsing mcp servers: {e}")
                        writer.log_error('mcp_parse', file_path, e)
                    try:
                        attrs = adapter.parse_session_attributes(raw, file_path)
                        if attrs:
                            sid = attrs.pop("session_id", None)
                            if sid:
                                session_attrs_id = sid
                            session_attrs.update(attrs)
                    except Exception as e:
                        print(f"Error parsing session attributes: {e}")
                        writer.log_error('session_attributes_parse', file_path, e)
                except Exception as e:
                    cnt_parse_errors += 1
                    last_parse_error = str(e)
                    print(f"Error parsing line in {file_path}: {e}")
                    writer.log_error('process_file', file_path, e)

        # ALL DuckDB writes serialize through _snapshot_lock (RC1 + snapshot
        # correctness). dbt_worker holds this lock during dbt subprocess runs
        # so no watcher connection is open while dbt holds the file lock.
        with lock_ctx:
            for sk in skill_batches:
                writer.insert_session_skills(sk)
            for mc in mcp_batches:
                writer.insert_session_mcps(mc)
            if events:
                writer.insert_events(events)
            if new_offset > offset:
                cp_manager.update_checkpoint(file_path, new_offset, last_uuid)
            # Task 4: persist per-file counters inside the same lock so the
            # stats row is always consistent with the checkpoint row.
            if cnt_lines_total > 0 or offset_was_reset:
                writer.update_file_stats(
                    file_path,
                    lines_total=cnt_lines_total,
                    events_kept=cnt_events_kept,
                    dropped_known=cnt_dropped_known,
                    dropped_unknown=cnt_dropped_unknown,
                    parse_errors=cnt_parse_errors,
                    last_error=last_parse_error,
                    reset=offset_was_reset,
                )
            # Upsert any session attributes captured from control records in
            # this file (ai-title, permission-mode, mode).  Guard on session_id
            # being known and at least one attribute being non-empty so we never
            # issue a no-op upsert that would race against an existing row.
            if session_attrs_id and session_attrs:
                try:
                    writer.upsert_session_attributes(
                        session_attrs_id,
                        title=session_attrs.get("title"),
                        permission_mode=session_attrs.get("permission_mode"),
                        mode=session_attrs.get("mode"),
                    )
                except Exception as e:
                    print(f"Error upserting session attributes for {file_path}: {e}")
                    writer.log_error('session_attributes', file_path, e)
    except Exception as e:
        print(f"Error processing {file_path}: {e}")
        writer.log_error('process_file', file_path, e)

class JSONLHandler(FileSystemEventHandler):
    def __init__(self, writer, cp_manager):
        # No single adapter is held: the format (Claude vs SDK trace) is sniffed
        # per file on each event, so one watcher handles both surfaces and a
        # fresh SdkTraceAdapter is created per SDK file (isolated run state).
        self.writer = writer
        self.cp_manager = cp_manager

    def on_modified(self, event):
        if not event.is_directory and event.src_path.endswith('.jsonl') and not is_workflow_journal(event.src_path):
            adapter = adapter_for_file(event.src_path)
            process_file(event.src_path, self.writer, adapter, self.cp_manager)

    def on_created(self, event):
        if not event.is_directory and event.src_path.endswith('.jsonl') and not is_workflow_journal(event.src_path):
            # JSONL layout: <project_dir>/<session_id>.jsonl — session_id is
            # the filename without extension, not the parent directory.
            session_id = os.path.splitext(os.path.basename(event.src_path))[0]
            # write_session_meta opens its own DuckDB connection — must
            # serialize through _snapshot_lock for the same reason
            # process_file does (parallel connect() = file handle conflict).
            try:
                with _snapshot_lock:
                    write_session_meta(self.writer, session_id, event.src_path)
            except Exception as e:
                print(f"Error writing session_meta for {session_id}: {e}")
                self.writer.log_error('session_meta', event.src_path, e)
            adapter = adapter_for_file(event.src_path)
            process_file(event.src_path, self.writer, adapter, self.cp_manager)

dbt_running = threading.Event()
# _snapshot_lock gates python-level DuckDB connects (take_snapshot and
# process_file writes) AND the dbt subprocess (RC1). dbt_worker holds this
# lock for the entire dbt run, so no watcher connection is open while dbt
# holds the DuckDB file lock — that is the single serialization point that
# prevents "Conflicting lock is held in python3.12 (PID ...)" drops.
# dbt_running remains an optimistic skip hint for snapshot_worker.
_snapshot_lock = threading.Lock()

# FR1 (2026-07-16): set exactly once, in main(), immediately after the
# initial (synchronous) backfill's run_batched_backfill() call returns. Read
# by dbt_worker (gates whether `dbt source freshness` runs this cycle) and by
# sweep_worker (gates its first tick). See dbt_worker / sweep_worker
# docstrings for the full rationale.
initial_backfill_done = threading.Event()

DEFAULT_BACKFILL_BATCH_SIZE = 200
DEFAULT_BACKFILL_BATCH_SECONDS = 120


def run_batched_backfill(
    to_process: list,
    writer: "DuckDBWriter",
    cp_manager: "CheckpointManager",
    snapshot_lock: threading.Lock,
    *,
    batch_size: int = DEFAULT_BACKFILL_BATCH_SIZE,
    batch_seconds: int = DEFAULT_BACKFILL_BATCH_SECONDS,
    progress_every: int = 50,
) -> int:
    """Ingest `to_process` files in batches so the initial backfill no longer
    monopolizes the DuckDB file lock for its entire (potentially 12h+)
    duration (2026-07-13 fix).

    Each batch opens ONE persistent DuckDB connection (writer.persistent_
    connection()) and processes up to `batch_size` files, or until
    `batch_seconds` of wall-clock time have elapsed since the batch started —
    whichever comes first. Exactly one file is unconditionally processed
    before the wall-clock check is ever consulted (the elapsed-time condition
    is skipped when batch_processed == 0), so even a pathological
    `batch_seconds <= 0` cannot stall the outer loop forever — every batch
    makes forward progress on at least one file.

    Locking scheme (deadlock-freedom argument):
      * `snapshot_lock` is acquired ONCE per batch, by THIS function, and
        held for the batch's entire duration — spanning both the persistent
        connection's lifetime and every process_file() call in the batch.
      * process_file() is called with hold_lock=False, so it does NOT try to
        acquire `snapshot_lock` itself inside the batch. `snapshot_lock` is a
        plain non-reentrant threading.Lock — a nested acquire by the same
        thread would deadlock that thread against itself. There is no such
        nested acquire anywhere in this path (process_file's internal
        `with lock_ctx:` becomes a no-op nullcontext when hold_lock=False).
      * Between batches, the lock is released AND the persistent connection
        is closed — in that order, because the persistent connection lives
        in the inner `with` block and the lock in the outer one. Exiting the
        inner block (closing the connection, releasing DuckDB's file lock)
        always happens strictly before exiting the outer block (releasing
        `snapshot_lock`). So no other lock user can ever observe
        "snapshot_lock free, but the persistent connection still open".
      * Every OTHER path that touches the DB or launches a dbt subprocess
        (snapshot_worker, dbt_worker, coverage_worker, JSONLHandler's live
        callbacks, process_verdicts_inbox) still acquires `snapshot_lock`
        itself (hold_lock defaults to True in process_file; the others call
        `with _snapshot_lock:` directly) before doing so. Because of the
        ordering above, by the time any of them successfully acquires the
        lock between batches, the persistent connection is GUARANTEED
        already closed — this is the proof that take_snapshot's connect()
        and the dbt subprocess launch never race the backfill's open
        connection ("Conflicting lock is held in python3.12 (PID ...)").

    Returns the total number of files processed (== len(to_process) on a
    clean run; every file in to_process is attempted exactly once, in order).
    """
    n = len(to_process)
    idx = 0
    while idx < n:
        with snapshot_lock:
            with writer.persistent_connection():
                batch_start = time.monotonic()
                batch_processed = 0
                while (
                    idx < n
                    and batch_processed < batch_size
                    and (
                        batch_processed == 0
                        or (time.monotonic() - batch_start) < batch_seconds
                    )
                ):
                    f = to_process[idx]
                    process_file(f, writer, adapter_for_file(f), cp_manager, hold_lock=False)
                    idx += 1
                    batch_processed += 1
                    if idx % progress_every == 0:
                        print(f"Backfill progress: {idx}/{n} files processed", flush=True)
        # snapshot_lock released AND persistent connection closed here (see
        # the docstring above) — this is the window where snapshot_worker /
        # dbt_worker / coverage_worker / live ingestion get to run.
    return idx


def snapshot_worker(src, dst, interval, writer):
    print(f"Snapshot worker started: {src} -> {dst} every {interval}s")
    while True:
        try:
            # Always snapshot under _snapshot_lock (the single correctness gate;
            # it's a single non-reentrant lock with no nested acquire anywhere, so
            # blocking here cannot deadlock). We no longer skip while dbt_running:
            # combined with a long snapshot interval, the skip meant snapshots
            # almost never landed a dbt-free window (dbt runs back-to-back ~7-8min
            # cycles), so the read DB went stale for tens of minutes and the
            # healthcheck failed. Now if dbt holds the lock we simply block until
            # the cycle ends, then copy — guaranteeing a refresh every interval.
            if os.path.exists(src):
                with _snapshot_lock:
                    take_snapshot(src, dst)
        except Exception as e:
            print(f"[snapshot] Warning: {e}")
            # W-H6: log_error opens a DuckDB connection — must serialize through
            # _snapshot_lock to avoid racing another connection that may have just
            # released the lock when take_snapshot raised.  Wrapped in try/except
            # so a secondary log failure never crashes the worker thread.
            try:
                with _snapshot_lock:
                    writer.log_error('snapshot', None, e)
            except Exception as log_exc:
                print(f"[snapshot] log_error failed (non-fatal): {log_exc}")
        time.sleep(interval)

def dbt_worker(interval_mins, writer):
    if interval_mins <= 0:
        print("DBT run worker disabled.")
        return
    print(f"DBT run worker started (every {interval_mins} mins).")
    while True:
        try:
            dbt_running.set()

            # Drain unknown models queued by ClaudeAdapter and surface them as
            # watcher_errors (once per model per process lifetime — the adapter
            # only adds a model to _pending_unknown the first time it warns).
            pending_models = set(_pending_unknown)
            _pending_unknown.difference_update(pending_models)
            for m in pending_models:
                writer.log_error(
                    'unknown_model',
                    None,
                    Exception(
                        f"model '{m}' not in MODEL_CONTEXT_WINDOWS / model_pricing.csv "
                        f"— add a pricing row to dbt/seeds/model_pricing.csv and run dbt seed"
                    )
                )

            # RC1: Wrap the four dbt subprocess calls in _snapshot_lock so that
            # no watcher DuckDB connection is open while dbt holds the file lock.
            # DuckDB allows only one writer process; without this guard dbt and
            # the watcher race for the file lock and the loser throws "Conflicting
            # lock is held in python3.12 (PID ...)".
            # The lock is held for the entire dbt run (freshness + seed + run +
            # test). process_file and snapshot_worker block on the lock during
            # this window — this is the intended serialization point.
            # dbt_running remains set so snapshot_worker can also use it as an
            # optimistic skip hint (belt-and-suspenders with the lock).
            # No deadlock: dbt_worker holds the lock here; snapshot_worker skips
            # (dbt_running.is_set()); process_file acquires the lock AFTER its
            # pure-I/O parse phase; there is no nested acquire in any path.
            with _snapshot_lock:
                # FR1 (2026-07-16): freshness moved to the TOP of the lock,
                # BEFORE seed/run/test, and gated on initial_backfill_done.
                #
                # Two independent bugs, one fix:
                #   1. Freshness used to run at the END of the ~14-30+ minute
                #      locked dbt cycle, so its "how stale is the data" verdict
                #      was always measured against data that was already
                #      14-30+ minutes stale BY THE TIME freshness looked at it
                #      — freshness was structurally guaranteed to under-report
                #      how fresh the data actually was at cycle start.
                #   2. On a fresh restart, dbt_worker's very first cycle is
                #      lock-blocked behind... nothing, actually — it runs FIRST,
                #      before the initial backfill has ingested anything (the
                #      backfill is lock-blocked behind cycle #1's `with
                #      _snapshot_lock:`), so that very first freshness check is
                #      guaranteed to report ERROR STALE regardless of how much
                #      data is about to land. Skipping freshness entirely until
                #      initial_backfill_done is set avoids reporting a
                #      guaranteed-wrong verdict during that startup window.
                #
                # Freshness stays INSIDE _snapshot_lock either way (it opens the
                # write DB) — only its position (top, not bottom) and whether it
                # runs at all (gated) changed. Seed → run → test order, and all
                # of their existing behavior (error logging, artifact copy,
                # history archival, number-verify) is otherwise UNCHANGED.
                if initial_backfill_done.is_set():
                    print("Invoking dbt source freshness...")
                    res_freshness = subprocess.run(
                        ["dbt", "source", "freshness", "--profiles-dir", ".", "--no-partial-parse"],
                        cwd="/app/dbt",
                        capture_output=True,
                        text=True
                    )
                    print(f"dbt source freshness stdout: {res_freshness.stdout}")
                    if res_freshness.stderr:
                        print(f"dbt source freshness stderr: {res_freshness.stderr}")
                else:
                    print("Skipping source freshness — initial backfill not complete")

                print("Invoking dbt seed...")
                res = subprocess.run(
                    ["dbt", "seed", "--profiles-dir", ".", "--no-partial-parse"],
                    cwd="/app/dbt",
                    capture_output=True,
                    text=True
                )
                print(f"dbt seed stdout: {res.stdout}")
                if res.stderr:
                    print(f"dbt seed stderr: {res.stderr}")
                # W-L8: surface dbt seed failures in watcher_errors.
                if res.returncode != 0:
                    writer.log_error(
                        'dbt_seed',
                        None,
                        Exception(f"dbt seed exited {res.returncode}: {res.stderr[:500]}")
                    )

                # `dbt run` (not `dbt build`) — we want models to refresh even when
                # data-quality tests fail. dbt build skips downstream models on test
                # failure, which leaves the dashboard stale on a single bad row.
                # Tests still run, just decoupled (see below).
                print("Invoking dbt run...")
                res2 = subprocess.run(
                    ["dbt", "run", "--profiles-dir", ".", "--no-partial-parse"],
                    cwd="/app/dbt",
                    capture_output=True,
                    text=True
                )
                print(f"dbt run stdout: {res2.stdout}")
                if res2.stderr:
                    print(f"dbt run stderr: {res2.stderr}")
                # W-L8: surface dbt run failures in watcher_errors.
                if res2.returncode != 0:
                    writer.log_error(
                        'dbt_run',
                        None,
                        Exception(f"dbt run exited {res2.returncode}: {res2.stderr[:500]}")
                    )

                # Tests run separately for observability — failures logged, never
                # block model materialization.
                print("Invoking dbt test...")
                res3 = subprocess.run(
                    ["dbt", "test", "--profiles-dir", ".", "--no-partial-parse"],
                    cwd="/app/dbt",
                    capture_output=True,
                    text=True
                )
                if res3.returncode != 0:
                    print(f"dbt test failures (non-blocking): {res3.stdout}")

            # Copy dbt artifacts to /data/artifacts/ so the frontend can read them.
            os.makedirs("/data/artifacts", exist_ok=True)
            for artifact in ["run_results.json", "sources.json", "manifest.json"]:
                src_artifact = f"/app/dbt/target/{artifact}"
                if os.path.exists(src_artifact):
                    try:
                        shutil.copy2(src_artifact, f"/data/artifacts/{artifact}")
                    except Exception as copy_exc:
                        print(f"[dbt_worker] artifact copy failed for {artifact}: {copy_exc}")

            # Archive run_results.json keyed by invocation time so the
            # observability page can show a recent-runs feed. We rotate to
            # keep only the last 20 history files (avoids unbounded growth
            # on a long-running deployment).
            src_rr = "/app/dbt/target/run_results.json"
            if os.path.exists(src_rr):
                history_dir = "/data/artifacts/history"
                os.makedirs(history_dir, exist_ok=True)
                ts_label = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                try:
                    shutil.copy2(src_rr, f"{history_dir}/{ts_label}.json")
                    history_files = sorted(
                        f for f in os.listdir(history_dir) if f.endswith(".json")
                    )
                    for stale in history_files[:-20]:
                        try:
                            os.remove(f"{history_dir}/{stale}")
                        except Exception as rm_exc:
                            # W-L4: log instead of silently swallowing.
                            print(f"[dbt_worker] failed to remove stale history file {stale}: {rm_exc}")
                except Exception as hist_exc:
                    print(f"[dbt_worker] history archival failed: {hist_exc}")

            # Number-map integrity verify — runs after dbt test, writes
            # /data/artifacts/number_verify.json for the /observability frontend.
            # Wrapped in its own try/except: any failure is logged but never
            # crashes the dbt cycle.
            try:
                res_verify = subprocess.run(
                    ["node", "/app/scripts/verify/run_all.mjs"],
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                print(f"number-verify: {res_verify.stdout.strip()}")
                if res_verify.returncode != 0 and res_verify.stderr:
                    print(f"number-verify stderr: {res_verify.stderr.strip()}")
            except Exception as verify_exc:
                print(f"[dbt_worker] number-verify failed (non-blocking): {verify_exc}")
                writer.log_error('number-verify', None, verify_exc)
        except Exception as e:
            print(f"Error running DBT build: {e}")
            writer.log_error('dbt', None, e)
        finally:
            dbt_running.clear()
        time.sleep(interval_mins * 60)

def coverage_worker(writer, scan_dirs, artifacts_dir, interval):
    """Periodically write ingest coverage snapshots to artifacts_dir.

    Runs every `interval` seconds (default 300). The glob over scan_dirs runs
    OUTSIDE _snapshot_lock (pure filesystem I/O); the DB reads inside
    write_coverage() are wrapped in _snapshot_lock by the caller here.
    """
    print(f"[coverage] Coverage worker started (every {interval}s)")
    while True:
        try:
            # Glob is pure I/O — do it outside the lock.
            all_files: list[str] = []
            for d in scan_dirs:
                all_files.extend(
                    glob.glob(os.path.join(d, "**", "*.jsonl"), recursive=True)
                )
            # Dedup paths (extra dirs may overlap logs_dir).
            all_files = list(set(all_files))

            with _snapshot_lock:
                write_coverage(writer, all_files, artifacts_dir, scan_dirs)
        except Exception as e:
            print(f"[coverage] error: {e}")
        time.sleep(interval)


def sweep_worker(
    writer: "DuckDBWriter",
    cp_manager: "CheckpointManager",
    scan_dirs: list[str],
    snapshot_lock: threading.Lock,
    interval: int,
    *,
    batch_size: int = DEFAULT_BACKFILL_BATCH_SIZE,
    batch_seconds: int = DEFAULT_BACKFILL_BATCH_SECONDS,
) -> None:
    """SW1 (2026-07-16): self-healing periodic ingest sweep.

    Rationale: live ingestion (the PollingObserver + JSONLHandler callback
    path) can silently freeze forever with no traceback and no watcher_errors
    row — confirmed live: ingestion froze at 2026-07-15 09:51 UTC and stayed
    dead for 27h while dbt cycles kept running normally on whatever
    raw_events already existed. Nothing detected the freeze; only a full
    container restart (which re-scans everything via the initial backfill)
    ever recovered it.

    Each tick re-runs list_backfill_files(scan_dirs) + the SAME bulk-
    checkpoint-read-then-filter-by-size pattern main() uses for the initial
    backfill (filter_files_with_new_bytes() is the shared piece) to find
    files whose on-disk size has grown past what's checkpointed — i.e. files
    the live watcher should have picked up but didn't. Those files (and ONLY
    those files) are re-ingested via run_batched_backfill(), which is safe to
    call repeatedly: it is checkpoint-offset-driven and every insert is
    `ON CONFLICT DO NOTHING` keyed on (tenant_id, uuid), so re-processing a
    file the live watcher actually DID handle concurrently is a no-op, not a
    duplicate (see the race-safety note in main()'s docstring-equivalent
    comment at the sweep_worker call site).

    Liveness alerting is rate-limited to exactly ONE watcher_errors row per
    "outage episode" (a run of consecutive sweeps that each found >=1 file
    with new bytes) — see the rate-limit comment inline below — so a
    multi-hour freeze does not flood watcher_errors with one row per sweep.
    """
    if interval <= 0:
        print("Ingest sweep worker disabled.")
        return
    print(f"[sweep] Ingest sweep worker started (every {interval}s).")

    # Wait for the initial (synchronous) backfill to finish before the first
    # tick. Sweeping DURING backfill would just re-discover the exact files
    # backfill is already working through (nothing is checkpointed yet, so
    # everything looks like "new bytes"), spamming redundant
    # run_batched_backfill calls and inflating the liveness-streak counter
    # with false positives that have nothing to do with a frozen observer.
    initial_backfill_done.wait()

    # Streak of consecutive sweeps that each found >=1 file with new bytes,
    # and whether THIS streak has already produced a watcher_errors row (see
    # the rate-limit comment below).
    consecutive_hits = 0
    alerted_this_streak = False

    while True:
        time.sleep(interval)
        try:
            files = list_backfill_files(scan_dirs)

            # Same bulk-checkpoint-read pattern as main()'s initial-backfill
            # selection (see main() for the twin of this block) — a short-
            # lived get_connection() under the lock, not a persistent one.
            cp_offsets: dict[str, int] = {}
            try:
                with snapshot_lock:
                    with writer.get_connection() as conn:
                        cp_offsets = {
                            fp: off
                            for fp, off in conn.execute(
                                "SELECT file_path, last_offset FROM ingest_checkpoints WHERE tenant_id = 'local'"
                            ).fetchall()
                        }
            except Exception as e:
                print(f"[sweep] bulk checkpoint read failed ({e}); skipping this tick")
                continue

            to_process = filter_files_with_new_bytes(files, cp_offsets)

            if to_process:
                consecutive_hits += 1
                print(f"[sweep] found {len(to_process)} file(s) with unread bytes (streak={consecutive_hits})")

                # Rate-limited liveness alert: intentionally NOT logged on
                # consecutive_hits == 1. A single sweep catching a normal race
                # against the live watcher (e.g. a file appended between two
                # PollingObserver ticks, or a file the watcher is mid-way
                # through processing) is expected and NOT evidence of the
                # 2026-07-15 09:51 UTC silent-freeze failure mode. Only when
                # the SAME condition persists into a SECOND consecutive sweep
                # (consecutive_hits == 2) do we treat it as evidence live
                # ingestion has actually stalled, and log exactly ONE
                # watcher_errors row. Sweeps 3, 4, 5, ... of the SAME streak
                # deliberately do NOT log again (alerted_this_streak guards
                # this) — otherwise a multi-hour freeze like the confirmed
                # incident (dead 27h) would produce one row per sweep interval
                # for the whole outage instead of one row for the episode. The
                # streak (and the alerted flag) resets to zero the moment a
                # sweep finds ZERO files with new bytes (see the else branch
                # below), so a LATER recurrence of the same failure mode can
                # alert again — this is not a permanent one-shot silence.
                if consecutive_hits == 2 and not alerted_this_streak:
                    alerted_this_streak = True
                    try:
                        with snapshot_lock:
                            writer.log_error(
                                'ingest_liveness',
                                None,
                                Exception(
                                    f"Live ingestion may be stalled: {len(to_process)} file(s) still had "
                                    f"unread bytes across 2 consecutive sweeps (interval={interval}s). "
                                    f"The PollingObserver has previously been observed to silently freeze "
                                    f"with no traceback (confirmed 2026-07-15 09:51 UTC, dead for 27h, "
                                    f"recovered only by a full container restart) — this sweep is now "
                                    f"re-ingesting the missed file(s) via run_batched_backfill."
                                ),
                            )
                    except Exception as log_exc:
                        print(f"[sweep] log_error failed (non-fatal): {log_exc}")

                run_batched_backfill(
                    to_process, writer, cp_manager, snapshot_lock,
                    batch_size=batch_size, batch_seconds=batch_seconds,
                )
            else:
                # A clean sweep (nothing to catch up on) proves live ingestion
                # is keeping up on its own — reset the streak so a LATER
                # recurrence of the freeze can alert again instead of being
                # permanently silenced after the first episode.
                consecutive_hits = 0
                alerted_this_streak = False
        except Exception as e:
            print(f"[sweep] error: {e}")
            try:
                with snapshot_lock:
                    writer.log_error('ingest_sweep', None, e)
            except Exception as log_exc:
                print(f"[sweep] log_error failed (non-fatal): {log_exc}")


VALID_VERDICTS = frozenset({"accepted", "wrong", "needs_review"})


def process_verdicts_inbox(inbox_path: str, writer: "DuckDBWriter", state: dict) -> None:
    """Read new lines from the verdicts inbox JSONL; validate; upsert to session_verdicts.

    Called from the main idle loop every 5 s. `state` is a plain dict with
    {"offset": int} that persists across calls so already-written lines are
    never re-processed. No new thread — runs synchronously on the main thread.
    """
    if not os.path.exists(inbox_path):
        return
    try:
        file_size = os.path.getsize(inbox_path)
        current_offset = state.get("offset", 0)
        if file_size < current_offset:
            current_offset = 0  # file was truncated/replaced
        if file_size == current_offset:
            return  # no new bytes

        rows: list = []
        new_offset = current_offset
        with open(inbox_path, "rb") as f:
            f.seek(current_offset)
            for raw_line in f:
                new_offset += len(raw_line)
                stripped = raw_line.strip()
                if not stripped:
                    continue
                try:
                    obj = json.loads(stripped.decode("utf-8"))
                except Exception as parse_exc:
                    print(f"[verdicts_inbox] JSON parse error (skipped): {parse_exc}")
                    writer.log_error("verdicts_inbox", inbox_path, Exception(f"JSON parse error: {parse_exc}"))
                    continue
                if not isinstance(obj, dict):
                    continue
                session_id = obj.get("session_id", "")
                verdict    = obj.get("verdict", "")
                if not isinstance(session_id, str) or not session_id.strip():
                    print(f"[verdicts_inbox] missing/empty session_id (skipped): {obj}")
                    continue
                if verdict not in VALID_VERDICTS:
                    print(f"[verdicts_inbox] invalid verdict '{verdict}' (skipped): {obj}")
                    continue
                note = obj.get("note") or None
                if isinstance(note, str) and len(note) > 500:
                    note = note[:500]
                rows.append([session_id.strip(), obj.get("tenant_id", "local"), verdict, note])

        if rows:
            with _snapshot_lock:
                with writer.get_connection() as conn:
                    conn.executemany(
                        """
                        INSERT INTO session_verdicts (session_id, tenant_id, verdict, note, created_at)
                        VALUES (?, ?, ?, ?, now())
                        ON CONFLICT (tenant_id, session_id)
                        DO UPDATE SET verdict = excluded.verdict,
                                      note = excluded.note,
                                      created_at = now()
                        """,
                        rows,
                    )
            print(f"[verdicts_inbox] upserted {len(rows)} verdict(s)")

        state["offset"] = new_offset

    except Exception as e:
        print(f"[verdicts_inbox] error: {e}")
        try:
            writer.log_error("verdicts_inbox", inbox_path, e)
        except Exception:
            pass


def main():
    logs_dir = os.getenv("AURA_LOGS_DIR", "/logs/claude")
    db_path = os.getenv("AURA_DB_PATH", "/data/aura.duckdb")
    # W-M8: basename of read_db_path MUST equal basename of db_path ("aura.duckdb")
    # so that dbt-compiled views (catalog = basename sans .duckdb) resolve
    # against the same catalog in both files. Docker sets this env var
    # explicitly; the default here covers bare-local dev only.
    read_db_path = os.getenv("AURA_READ_DB_PATH", "/data/read/aura.duckdb")
    snapshot_interval = int(os.getenv("AURA_SNAPSHOT_INTERVAL", "2"))
    dbt_interval = int(os.getenv("AURA_DBT_RUN_INTERVAL_MINUTES", "5"))

    # AURA_EXTRA_TRACE_DIRS: comma-separated extra directories to ingest
    # alongside logs_dir (e.g. an SDK tracer's output dir). Each is backfilled
    # and watched recursively. Non-existent entries are skipped with a warning.
    extra_dirs_raw = os.getenv("AURA_EXTRA_TRACE_DIRS", "")
    extra_dirs = [d.strip() for d in extra_dirs_raw.split(",") if d.strip()]

    print("Starting Aura Watcher...")
    print(f"Logs: {logs_dir}")
    if extra_dirs:
        print(f"Extra trace dirs: {extra_dirs}")
    print(f"Write DB: {db_path}")

    verdicts_inbox_path  = os.getenv("AURA_VERDICTS_INBOX", "/data/verdicts-inbox.jsonl")
    verdicts_inbox_state = {"offset": 0}

    # TMP1: purge orphaned DuckDB spill files BEFORE the first connection is
    # opened and before any worker thread starts — see purge_duckdb_spill_dir's
    # docstring for the full 16383.9 PiB temp-dir-accounting-underflow
    # rationale. This MUST run before DuckDBWriter(db_path) below.
    purge_duckdb_spill_dir(db_path)

    writer = DuckDBWriter(db_path)
    cp_manager = CheckpointManager(writer)

    artifacts_dir = os.getenv("AURA_ARTIFACTS_DIR", "/data/artifacts")
    coverage_interval = int(os.getenv("AURA_COVERAGE_INTERVAL", "300"))
    # SW1: interval for the self-healing periodic ingest sweep (see
    # sweep_worker's docstring). <=0 disables it entirely, matching the
    # existing dbt_interval <= 0 disable pattern above.
    sweep_interval = int(os.getenv("AURA_SWEEP_INTERVAL_SECONDS", "600"))

    # Backfill batching (2026-07-13 fix): the initial backfill used to hold
    # ONE persistent DuckDB connection (and, before that, per-file connections)
    # for its ENTIRE duration — on a large corpus (~15k files) that is 12h+
    # during which the DuckDB file lock never comes free, so snapshot_worker
    # and dbt_worker (started only AFTER backfill finished) never got to run
    # and the read DB / dashboard froze for the whole backfill. Restored
    # behavior: snapshot/dbt/coverage now start BEFORE the backfill loop, and
    # the backfill itself is chunked into batches (see run_batched_backfill())
    # so the file lock is released — and the workers get a window to run —
    # every `batch_size` files or `batch_seconds`, whichever comes first.
    backfill_batch_size = int(os.getenv("AURA_BACKFILL_BATCH_SIZE", str(DEFAULT_BACKFILL_BATCH_SIZE)))
    backfill_batch_seconds = int(os.getenv("AURA_BACKFILL_BATCH_SECONDS", str(DEFAULT_BACKFILL_BATCH_SECONDS)))

    # logs_dir + every extra trace dir, merged once, reused below by
    # coverage_worker, sweep_worker, and the initial backfill listing so all
    # three surfaces scan exactly the same set of directories.
    scan_dirs = [logs_dir] + [d for d in extra_dirs if os.path.isdir(d)]

    # Start the periodic workers BEFORE the backfill loop begins, not after.
    # Each still gates every DB touch (or dbt subprocess launch) on
    # _snapshot_lock exactly as it always has — the only thing that changed is
    # WHEN the backfill releases that lock (every batch, not once at the very
    # end). This is what lets dbt/the snapshot run on "whatever data exists"
    # (per the documented design) DURING a long backfill instead of only after.
    threading.Thread(target=snapshot_worker, args=(db_path, read_db_path, snapshot_interval, writer), daemon=True).start()
    threading.Thread(
        target=coverage_worker,
        args=(writer, scan_dirs, artifacts_dir, coverage_interval),
        daemon=True,
    ).start()
    threading.Thread(target=dbt_worker, args=(dbt_interval, writer), daemon=True).start()
    # SW1: started alongside the other periodic workers, but its own loop
    # blocks (initial_backfill_done.wait()) until the initial backfill below
    # has finished — see sweep_worker's docstring.
    #
    # Race safety (sweep vs. the live JSONLHandler on the SAME file): both
    # can independently decide a file "has new bytes" and call process_file
    # on it around the same time — e.g. the live watcher is mid-way through
    # a file when a sweep tick's checkpoint snapshot (taken moments earlier)
    # still shows the pre-append offset. This is SAFE, not a bug:
    #   * process_file's DuckDB writes (insert_events, update_checkpoint) only
    #     ever run under _snapshot_lock (hold_lock=True live, or the caller's
    #     batch lock via run_batched_backfill hold_lock=False) — the two
    #     call paths can never hold the lock at the same instant, so their
    #     writes never interleave.
    #   * insert_events is `ON CONFLICT (tenant_id, uuid) DO NOTHING` — if
    #     both paths read-and-parse the same byte range before either writes
    #     (impossible here since writes are lock-serialized, but even in the
    #     degenerate case), the second writer's rows are simply no-ops.
    #   * update_checkpoint always writes the offset computed from THAT
    #     call's own read pass; whichever of the two writers' lock-protected
    #     write phase runs second will (at worst) redundantly re-save the
    #     same or a further-advanced offset — it can never move the
    #     checkpoint BACKWARD, since both passes start from a
    #     checkpoint >= what was on disk when they began reading.
    # Net effect: a sweep racing the live watcher on the same file produces
    # zero duplicate raw_events rows and a monotonically-advancing checkpoint
    # — at most some wasted re-parse work, never incorrect data.
    threading.Thread(
        target=sweep_worker,
        args=(writer, cp_manager, scan_dirs, _snapshot_lock, sweep_interval),
        kwargs={"batch_size": backfill_batch_size, "batch_seconds": backfill_batch_seconds},
        daemon=True,
    ).start()

    # Files are sorted OLDEST-first (2026-07-14, see list_backfill_files()
    # docstring for the full rationale: this is a deliberate reversal of the
    # 2026-07 newest-first choice, done to keep the raw_events ingestion
    # frontier — and therefore the "backfill lag" observability metric —
    # truthful while a large backlog is being processed). The full set is
    # always processed — backfill is all-or-nothing on the bronze layer
    # (raw_events). dbt is independent and replayable from raw_events.
    # logs_dir + every extra trace dir are merged into one oldest-first list,
    # and the listing is resilient to files disappearing between glob() and
    # stat() (ephemeral subagent-workflow files) — see list_backfill_files().
    print("Running initial backfill...")
    files = list_backfill_files(scan_dirs)
    print(f"Found {len(files)} files to backfill", flush=True)
    # Skip already-complete files via ONE bulk checkpoint read instead of a
    # per-file DuckDB connection. A per-file get_checkpoint is slow on the large
    # write DB and now serializes against the dbt subprocess (_snapshot_lock),
    # which stalled live-ingestion startup for a long time on restart. Only
    # files with new bytes (offset < size, or no checkpoint) are processed.
    # This quick read is its own short-lived get_connection() (not a
    # persistent one) — it is brief enough that holding _snapshot_lock for it
    # does not meaningfully delay snapshot_worker/dbt_worker, which are already
    # running concurrently by this point.
    cp_offsets: dict[str, int] = {}
    try:
        with _snapshot_lock:
            with writer.get_connection() as conn:
                cp_offsets = {
                    fp: off
                    for fp, off in conn.execute(
                        "SELECT file_path, last_offset FROM ingest_checkpoints WHERE tenant_id = 'local'"
                    ).fetchall()
                }
    except Exception as e:
        print(f"[backfill] bulk checkpoint read failed ({e}); processing all files", flush=True)

    # SW1: filter logic extracted to filter_files_with_new_bytes() so
    # sweep_worker() reuses the exact same "has new bytes" definition instead
    # of a second, potentially drifting, copy — behavior here is unchanged.
    to_process = filter_files_with_new_bytes(files, cp_offsets)
    print(f"Backfill: {len(to_process)} of {len(files)} files have new bytes", flush=True)

    # Perf fix (2026-07-13, batched): each batch reuses ONE persistent DuckDB
    # connection across up to `backfill_batch_size` files (or `backfill_batch_
    # seconds` of wall time, whichever comes first) instead of reconnecting
    # per file — connect()/close() re-opens the catalog + WAL on a large write
    # DB, which was the dominant per-file cost (~15s/file) before the earlier
    # persistent-connection fix. Unlike that earlier fix, the connection is
    # NOT held for the whole backfill: it is closed at every batch boundary
    # (see run_batched_backfill()) so snapshot_worker/dbt_worker/coverage_
    # worker — already running concurrently — get a real window to acquire
    # the DuckDB file lock and refresh the dashboard while backfill is still
    # in progress, instead of freezing until the entire backfill completes.
    processed_count = run_batched_backfill(
        to_process,
        writer,
        cp_manager,
        _snapshot_lock,
        batch_size=backfill_batch_size,
        batch_seconds=backfill_batch_seconds,
    )
    print(f"Backfill complete. Processed {processed_count} of {len(files)} files.", flush=True)
    # FR1 / SW1: signal that the initial backfill has finished. dbt_worker's
    # NEXT cycle (may already be mid-cycle right now, holding _snapshot_lock —
    # that's fine, this is just a flag) will run `dbt source freshness`
    # instead of skipping it, and the sweep_worker thread (already running,
    # started above, currently blocked on initial_backfill_done.wait())
    # unblocks and starts ticking. Deliberately set exactly once per process
    # lifetime — there is no "re-arm" path, mirroring "initial backfill"
    # being a once-per-startup event.
    initial_backfill_done.set()

    # session_meta + session_attributes history backfills read every file fully,
    # which is slow on a large corpus and would block the watch loop (delaying
    # live ingestion) for minutes on restart. Run them in a background daemon
    # thread so watching starts immediately. They upsert under _snapshot_lock,
    # so they serialize safely with the watcher / dbt / snapshot workers.
    def _history_backfill():
        try:
            written, skipped = backfill_session_meta(writer, files, _snapshot_lock)
            print(f"session_meta backfill: wrote={written} skipped_existing={skipped}", flush=True)
        except Exception as e:
            print(f"Error during session_meta backfill: {e}", flush=True)
            writer.log_error('session_meta', None, e)
        try:
            attrs_upserted = backfill_session_attributes(writer, files, _snapshot_lock)
            print(f"session_attributes backfill: upserted={attrs_upserted} sessions", flush=True)
        except Exception as e:
            print(f"Error during session_attributes backfill: {e}", flush=True)
            writer.log_error('session_attributes', None, e)

    threading.Thread(target=_history_backfill, daemon=True).start()

    # Start Watchdog
    handler = JSONLHandler(writer, cp_manager)
    # PollingObserver works on all platforms including Windows bind-mounts in
    # Docker where inotify (Observer) silently drops events.
    observer = PollingObserver(timeout=10)
    observer.schedule(handler, logs_dir, recursive=True)
    # Watch every existing extra trace dir too. Skipped (with a warning) if a
    # configured dir doesn't exist, so a stale env var never crashes startup.
    for d in extra_dirs:
        if os.path.isdir(d):
            observer.schedule(handler, d, recursive=True)
            print(f"Watching extra trace dir: {d}")
        else:
            print(f"[main] extra trace dir does not exist, skipping: {d}")
    observer.start()

    print("Watching for changes...")

    # snapshot_worker / coverage_worker / dbt_worker are already running (started
    # earlier, before the backfill loop — see above) so they can refresh the
    # dashboard on their normal cadence throughout the whole backfill, not just
    # after it finishes.

    _verdict_ticks = 0
    try:
        while True:
            time.sleep(1)
            _verdict_ticks += 1
            if _verdict_ticks >= 5:
                _verdict_ticks = 0
                process_verdicts_inbox(verdicts_inbox_path, writer, verdicts_inbox_state)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    main()
