import json
import os
import time
import threading
import glob
import subprocess
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from aura_watcher.duckdb_writer import DuckDBWriter
from aura_watcher.adapters.claude import ClaudeAdapter
from aura_watcher.checkpoint import CheckpointManager
from aura_watcher.snapshot import take_snapshot
from aura_watcher.session_meta import write_session_meta

def process_file(file_path, writer, adapter, cp_manager):
    if dbt_running.is_set():
        return
    try:
        if not os.path.exists(file_path):
            return

        # Read & parse outside the DB lock (no I/O contention there).
        checkpoint = cp_manager.get_checkpoint(file_path)
        offset = checkpoint["last_offset"]

        with open(file_path, 'rb') as f:
            f.seek(offset)
            lines = f.readlines()
            new_offset = f.tell()

        if new_offset <= offset:
            return  # No new bytes

        last_uuid = checkpoint["last_line_uuid"]
        events = []
        skill_batches: list[list[dict]] = []
        for line in lines:
            try:
                if not line.strip(): continue
                raw = json.loads(line.decode('utf-8'))
                event = adapter.parse_line(raw, file_path, offset)
                if event:
                    events.append(event)
                    last_uuid = event["uuid"]
                try:
                    skills = adapter.parse_skills(raw, file_path)
                    if skills:
                        skill_batches.append(skills)
                except Exception as e:
                    print(f"Error parsing skills: {e}")
            except Exception as e:
                print(f"Error parsing line in {file_path}: {e}")

        # ALL DuckDB writes serialize through _snapshot_lock so the snapshot
        # worker's force_checkpoint never races with concurrent inserts
        # (DuckDB rejects parallel `duckdb.connect()` from different threads
        # against the same file: "Unique file handle conflict").
        with _snapshot_lock:
            if dbt_running.is_set():
                return
            for sk in skill_batches:
                writer.insert_session_skills(sk)
            if events:
                writer.insert_events(events)
            if new_offset > offset:
                cp_manager.update_checkpoint(file_path, new_offset, last_uuid)
    except Exception as e:
        print(f"Error processing {file_path}: {e}")

class JSONLHandler(FileSystemEventHandler):
    def __init__(self, writer, adapter, cp_manager):
        self.writer = writer
        self.adapter = adapter
        self.cp_manager = cp_manager

    def on_modified(self, event):
        if not event.is_directory and event.src_path.endswith('.jsonl'):
            process_file(event.src_path, self.writer, self.adapter, self.cp_manager)

    def on_created(self, event):
        if not event.is_directory and event.src_path.endswith('.jsonl'):
            session_id = os.path.basename(os.path.dirname(event.src_path))
            # write_session_meta opens its own DuckDB connection — must
            # serialize through _snapshot_lock for the same reason
            # process_file does (parallel connect() = file handle conflict).
            with _snapshot_lock:
                if not dbt_running.is_set():
                    write_session_meta(self.writer, session_id, event.src_path)
            process_file(event.src_path, self.writer, self.adapter, self.cp_manager)

dbt_running = threading.Event()
# Held by snapshot_worker while take_snapshot is running; dbt_worker acquires it
# to guarantee no snapshot connection is open before launching dbt.
_snapshot_lock = threading.Lock()

def snapshot_worker(src, dst, interval):
    print(f"Snapshot worker started: {src} -> {dst} every {interval}s")
    while True:
        try:
            if dbt_running.is_set():
                time.sleep(1)
                continue

            if os.path.exists(src):
                with _snapshot_lock:
                    if not dbt_running.is_set():
                        take_snapshot(src, dst)
        except Exception as e:
            print(f"[snapshot] Warning: {e}")
        time.sleep(interval)

def dbt_worker(interval_mins):
    if interval_mins <= 0:
        print("DBT run worker disabled.")
        return
    print(f"DBT run worker started (every {interval_mins} mins).")
    while True:
        try:
            dbt_running.set()
            # Block until any in-flight snapshot releases its DuckDB connection,
            # then hold the lock for the full dbt run so no new snapshot starts.
            with _snapshot_lock:
                time.sleep(1)  # Allow any in-flight process_file writes to drain

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
        except Exception as e:
            print(f"Error running DBT build: {e}")
        finally:
            dbt_running.clear()
        time.sleep(interval_mins * 60)

def main():
    logs_dir = os.getenv("AURA_LOGS_DIR", "/logs/claude")
    db_path = os.getenv("AURA_DB_PATH", "/data/aura.duckdb")
    read_db_path = os.getenv("AURA_READ_DB_PATH", "/data/aura_read.duckdb")
    snapshot_interval = int(os.getenv("AURA_SNAPSHOT_INTERVAL", "2"))
    dbt_interval = int(os.getenv("AURA_DBT_RUN_INTERVAL_MINUTES", "5"))

    print(f"Starting Aura Watcher...")
    print(f"Logs: {logs_dir}")
    print(f"Write DB: {db_path}")

    writer = DuckDBWriter(db_path)
    adapter = ClaudeAdapter()
    cp_manager = CheckpointManager(writer)

    # Initial Backfill BEFORE starting the snapshot worker.
    # Rationale: DuckDB does not allow two parallel `duckdb.connect()` calls
    # against the same file from different threads — they collide with
    # "Unique file handle conflict: Cannot attach <db> ... already attached".
    # The snapshot worker (which opens its own connection for force_checkpoint)
    # therefore MUST NOT race with backfill's bulk inserts.
    print("Running initial backfill...")
    files = glob.glob(os.path.join(logs_dir, "**", "*.jsonl"), recursive=True)
    for f in files:
        process_file(f, writer, adapter, cp_manager)
    print(f"Backfill complete. Processed {len(files)} files.")

    # Backfill session_meta for any sessions not yet recorded
    from aura_watcher.session_meta import ensure_session_meta_table
    for f in files:
        session_id = os.path.basename(os.path.dirname(f))
        try:
            with writer.get_connection() as conn:
                ensure_session_meta_table(conn)
                row = conn.execute(
                    "SELECT 1 FROM session_meta WHERE session_id = ?", [session_id]
                ).fetchone()
            if row is None:
                write_session_meta(writer, session_id, f)
        except Exception as e:
            print(f"Error writing session_meta for {session_id}: {e}")

    # NOW start the snapshot worker — backfill writes have all flushed.
    threading.Thread(target=snapshot_worker, args=(db_path, read_db_path, snapshot_interval), daemon=True).start()

    # Start DBT worker in the background.
    threading.Thread(target=dbt_worker, args=(dbt_interval,), daemon=True).start()

    # Start Watchdog
    handler = JSONLHandler(writer, adapter, cp_manager)
    observer = Observer()
    observer.schedule(handler, logs_dir, recursive=True)
    observer.start()

    print(f"Watching for changes...")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    main()
