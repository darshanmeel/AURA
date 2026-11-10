"""Aura watcher: JSONL transcripts -> Parquet lake -> dbt -> published read DB.

One ingest thread (this one) owns the buffers, the checkpoints and SQLite; a
dbt thread runs ``dbt_cycle.run_cycle`` every AURA_DBT_RUN_INTERVAL_MINUTES.
"""

import argparse
import json
import os
import queue
import signal
import socket
import sys
import threading
import time
import traceback
from pathlib import Path
from types import SimpleNamespace

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer
from watchdog.observers.polling import PollingObserver

from aura_watcher import dbt_cycle, ingest, lake, state
from aura_watcher.coverage import write_coverage

STATUS_FILE = "watcher_status.json"
GUARD_SECONDS = 120
COMPACT_EVERY_SECONDS = 600


def _p(v: str) -> str:
    return Path(v).resolve().as_posix()


def load_config(env=os.environ) -> SimpleNamespace:
    data = _p(env.get("AURA_DATA_DIR", "/data"))
    extra = [d.strip() for d in env.get("AURA_EXTRA_TRACE_DIRS", "").split(",") if d.strip()]
    return SimpleNamespace(
        data_dir=data,
        run_mode=env.get("AURA_RUN_MODE", "unknown"),
        lake_dir=_p(env.get("AURA_LAKE_DIR", f"{data}/lake")),
        state_db=_p(env.get("AURA_STATE_DB", f"{data}/state/aura_state.sqlite")),
        db_path=_p(env.get("AURA_DB_PATH", f"{data}/work/aura.duckdb")),
        read_dir=_p(env.get("AURA_READ_DIR", f"{data}/read")),
        artifacts_dir=_p(env.get("AURA_ARTIFACTS_DIR", f"{data}/artifacts")),
        verdicts_inbox=_p(env.get("AURA_VERDICTS_INBOX", f"{data}/inbox/verdicts-inbox.jsonl")),
        logs_dir=_p(env.get("AURA_LOGS_DIR", "/logs/claude")),
        extra_dirs=[_p(d) for d in extra],
        flush_seconds=float(env.get("AURA_FLUSH_SECONDS", "30")),
        flush_max_rows=int(env.get("AURA_FLUSH_MAX_ROWS", "20000")),
        compact_min_files=int(env.get("AURA_COMPACT_MIN_FILES", "50")),
        observer=env.get("AURA_OBSERVER", "polling"),
        poll_seconds=float(env.get("AURA_POLL_SECONDS", "30")),
        sweep_interval=float(env.get("AURA_SWEEP_INTERVAL_SECONDS", "600")),
        coverage_interval=float(env.get("AURA_COVERAGE_INTERVAL", "300")),
        dbt_interval=float(env.get("AURA_DBT_RUN_INTERVAL_MINUTES", "5")),
        dbt_timeout=float(env.get("AURA_DBT_TIMEOUT_SECONDS", "1800")),
        dbt_dir=_p(env.get("AURA_DBT_DIR", "/app/dbt")),
        verify_script=_p(env.get("AURA_VERIFY_SCRIPT", "/app/scripts/verify/run_all.mjs")),
    )


def mode_guard(artifacts_dir: str, mode: str) -> str | None:
    """C3: refuse to run while a watcher of the other mode wrote its status in
    the last 120 s; both would write the same lake, state DB and work DB."""
    path = os.path.join(artifacts_dir, STATUS_FILE)
    try:
        if time.time() - os.path.getmtime(path) >= GUARD_SECONDS:
            return None
        with open(path, encoding="utf-8") as f:
            other = json.load(f)
    except (OSError, ValueError):
        return None
    if other.get("mode") != mode:
        return (f"another Aura watcher ({other.get('mode')} on {other.get('host')}) is running; "
                f"stop it or wait {GUARD_SECONDS} s")
    return None


def startup(cfg):
    """Mode guard, folders, lake housekeeping, inbox, state. Returns the ingest context."""
    msg = mode_guard(cfg.artifacts_dir, cfg.run_mode)
    if msg:
        print(msg, flush=True)
        sys.exit(2)
    for d in (cfg.lake_dir, os.path.dirname(cfg.state_db), os.path.dirname(cfg.db_path), cfg.read_dir,
              cfg.artifacts_dir, os.path.dirname(cfg.verdicts_inbox)):
        os.makedirs(d, exist_ok=True)
    lake.clean_tmp(cfg.lake_dir)
    lake.ensure_tables(cfg.lake_dir)
    open(cfg.verdicts_inbox, "a").close()
    dbt_cycle.purge_duckdb_spill_dir(cfg.db_path)
    con = state.open_state(cfg.state_db)
    roots = ingest.make_roots(cfg.logs_dir, cfg.extra_dirs)
    scratch = os.path.join(os.path.dirname(cfg.state_db), "flush.ndjson")
    return ingest.new_context(con, roots, cfg.lake_dir, scratch, cfg.flush_max_rows)


def write_status(cfg, ctx, started_at: str) -> None:
    # last_sweep sizes can be older than the checkpoints, so only a size ahead of the offset is pending.
    pending = [(lp, size) for lp, size, _ in ctx.last_sweep
               if size > (ctx.checkpoints.get(lp) or {}).get("last_offset", 0)]
    doc = {
        "written_at": dbt_cycle._iso(), "started_at": started_at, "mode": cfg.run_mode,
        "host": socket.gethostname(), "observer": cfg.observer,
        "last_flush_at": ctx.last_flush_at and ctx.last_flush_at + "Z",
        "last_flush_rows": ctx.last_flush_rows, "max_event_ts": ctx.max_event_ts,
        "files_tracked": len(ctx.checkpoints),
        "bytes_tracked": sum(cp["last_offset"] for cp in ctx.checkpoints.values()),
        "files_pending": len(pending),
        "bytes_pending": sum(size - (ctx.checkpoints.get(lp) or {}).get("last_offset", 0) for lp, size in pending),
        "errors_since_start": ctx.errors_since_start,
        "last_compaction_at": state.get_meta(ctx.con, "last_compaction_utc"),
        "dbt": dict(dbt_cycle.status),
    }
    path = os.path.join(cfg.artifacts_dir, STATUS_FILE)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(doc, f, default=str)
    os.replace(path + ".tmp", path)


class _Handler(FileSystemEventHandler):
    def __init__(self, dirty: queue.Queue, roots):
        self.dirty = dirty
        self.roots = roots

    def on_modified(self, event):
        if not event.is_directory and event.src_path.endswith(".jsonl"):
            lp = ingest.logical_path(event.src_path, self.roots)
            if lp and not ingest.is_workflow_journal(lp):
                self.dirty.put(lp)

    on_created = on_modified


def _start_observer(cfg, roots, dirty):
    obs = Observer() if cfg.observer == "native" else PollingObserver(timeout=cfg.poll_seconds)
    handler = _Handler(dirty, roots)
    for _, root in roots:
        if os.path.isdir(root):
            obs.schedule(handler, root, recursive=True)
        else:
            print(f"[main] watch dir does not exist, skipping: {root}")
    obs.start()
    return obs


def _dbt_loop(cfg, log_error, stop: threading.Event) -> None:
    if cfg.dbt_interval <= 0:
        print("[dbt] worker disabled")
        return
    while not stop.is_set():
        start = time.monotonic()
        try:
            dbt_cycle.run_cycle(cfg, log_error)
        except Exception as e:
            log_error("dbt", None, str(e), traceback.format_exc())
        stop.wait(max(0.0, start + cfg.dbt_interval * 60 - time.monotonic()))


def _process_dirty(ctx, dirty: queue.Queue, timeout: float) -> None:
    try:
        ingest.process_file(ctx, dirty.get(timeout=timeout))
    except queue.Empty:
        pass


def run_once(cfg, ctx, with_dbt: bool) -> int:
    started_at = dbt_cycle._iso()
    dirty: queue.Queue = queue.Queue()
    ingest.sweep(ctx, dirty.put)
    while not dirty.empty():
        _process_dirty(ctx, dirty, 0)
    ingest.flush(ctx)
    code = 0
    if with_dbt:
        log_error = _error_logger(ctx)
        code = 0 if dbt_cycle.run_cycle(cfg, log_error, force=True) == "ok" else 1
        ingest.flush(ctx)
    write_status(cfg, ctx, started_at)
    return code


def _error_logger(ctx):
    def log_error(source, file_path, message, stack=None):
        ingest.push_error(ctx.errors, source, file_path, message, stack)
    return log_error


def run(cfg, ctx) -> None:
    started_at = dbt_cycle._iso()
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    dirty: queue.Queue = queue.Queue()
    log_error = _error_logger(ctx)
    obs = _start_observer(cfg, ctx.roots, dirty)
    threading.Thread(target=_dbt_loop, args=(cfg, log_error, stop), daemon=True).start()

    now = time.monotonic()
    ingest.sweep(ctx, dirty.put)  # the startup sweep is the backfill
    next_flush = now + cfg.flush_seconds
    next_sweep = now + cfg.sweep_interval
    next_cov = now
    next_compact = now + COMPACT_EVERY_SECONDS
    print(f"[main] watching {[r for _, r in ctx.roots]}", flush=True)
    while not stop.is_set():
        _process_dirty(ctx, dirty, 1.0)
        now = time.monotonic()
        if now >= next_flush:
            ingest.flush(ctx)
            write_status(cfg, ctx, started_at)
            next_flush = now + cfg.flush_seconds
        if cfg.sweep_interval > 0 and now >= next_sweep:
            ingest.sweep(ctx, dirty.put)
            next_sweep = now + cfg.sweep_interval
        if now >= next_cov:
            files = [(lp, size) for lp, size, _ in ctx.last_sweep]
            write_coverage(files, ctx.checkpoints, ctx.stats, cfg.artifacts_dir, [r for _, r in ctx.roots])
            next_cov = now + cfg.coverage_interval
        if now >= next_compact:
            today = lake.utcnow().strftime("%Y-%m-%d")
            if lake.compact(cfg.lake_dir, today, os.path.dirname(cfg.db_path), cfg.compact_min_files, log_error):
                state.set_meta(ctx.con, "last_compaction_utc", dbt_cycle._iso())
            next_compact = now + COMPACT_EVERY_SECONDS

    print("[main] stopping: final flush", flush=True)
    ingest.flush(ctx)
    write_status(cfg, ctx, started_at)
    obs.stop()
    obs.join(timeout=5)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="aura_watcher.main")
    ap.add_argument("--once", action="store_true", help="one sweep + flush, then exit")
    ap.add_argument("--with-dbt", action="store_true", help="with --once: also run one dbt cycle")
    args = ap.parse_args(argv)
    cfg = load_config()
    ctx = startup(cfg)
    if args.once:
        return run_once(cfg, ctx, args.with_dbt)
    run(cfg, ctx)
    return 0


if __name__ == "__main__":
    sys.exit(main())
