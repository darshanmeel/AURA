import json
import os
import time
import threading
import glob
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from aura_watcher.duckdb_writer import DuckDBWriter
from aura_watcher.adapters.claude import ClaudeAdapter
from aura_watcher.checkpoint import CheckpointManager
from aura_watcher.snapshot import take_snapshot

def process_file(file_path, writer, adapter, cp_manager):
    checkpoint = cp_manager.get_checkpoint(file_path)
    offset = checkpoint["last_offset"]
    
    if not os.path.exists(file_path):
        return

    try:
        with open(file_path, 'rb') as f:
            f.seek(offset)
            lines = f.readlines()
            new_offset = f.tell()
            last_uuid = checkpoint["last_line_uuid"]
            
            events = []
            for line in lines:
                try:
                    if not line.strip(): continue
                    raw = json.loads(line.decode('utf-8'))
                    event = adapter.parse_line(raw, file_path, offset)
                    if event:
                        events.append(event)
                        last_uuid = event["uuid"]
                except Exception as e:
                    print(f"Error parsing line in {file_path}: {e}")
            
            if events:
                writer.insert_events(events)
            
            if new_offset > offset:
                cp_manager.update_checkpoint(file_path, new_offset, last_uuid)
    except Exception as e:
        print(f"Error reading {file_path}: {e}")

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
            process_file(event.src_path, self.writer, self.adapter, self.cp_manager)

def snapshot_worker(src, dst, interval):
    print(f"Snapshot worker started: {src} -> {dst} every {interval}s")
    while True:
        try:
            if os.path.exists(src):
                take_snapshot(src, dst)
            else:
                # Still waiting for the first write to create the file
                pass
        except Exception as e:
            # Locking errors are expected if the backfill is busy
            pass
        time.sleep(interval)

def main():
    logs_dir = os.getenv("AURA_LOGS_DIR", "/logs/claude")
    db_path = os.getenv("AURA_DB_PATH", "/data/aura.duckdb")
    read_db_path = os.getenv("AURA_READ_DB_PATH", "/data/aura_read.duckdb")
    snapshot_interval = int(os.getenv("AURA_SNAPSHOT_INTERVAL", "2"))

    print(f"Starting Aura Watcher...")
    print(f"Logs: {logs_dir}")
    print(f"Write DB: {db_path}")

    writer = DuckDBWriter(db_path)
    adapter = ClaudeAdapter()
    cp_manager = CheckpointManager(writer)

    # Start Snapshot Worker BEFORE backfill so UI gets data ASAP
    threading.Thread(target=snapshot_worker, args=(db_path, read_db_path, snapshot_interval), daemon=True).start()

    # Initial Backfill
    print("Running initial backfill...")
    files = glob.glob(os.path.join(logs_dir, "**", "*.jsonl"), recursive=True)
    for f in files:
        process_file(f, writer, adapter, cp_manager)
    print(f"Backfill complete. Processed {len(files)} files.")

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
