import json
import os
import time
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from aura_watcher.duckdb_writer import DuckDBWriter
from aura_watcher.adapters.claude import ClaudeAdapter
from aura_watcher.checkpoint import CheckpointManager

def process_file(file_path, writer, adapter, cp_manager):
    checkpoint = cp_manager.get_checkpoint(file_path)
    offset = checkpoint["last_offset"]
    
    if not os.path.exists(file_path):
        return

    with open(file_path, 'rb') as f:
        f.seek(offset)
        lines = f.readlines()
        new_offset = f.tell()
        last_uuid = checkpoint["last_line_uuid"]
        
        for line in lines:
            try:
                raw = json.loads(line.decode('utf-8'))
                event = adapter.parse_line(raw, file_path, offset)
                writer.insert_event(event)
                last_uuid = event["uuid"]
            except Exception as e:
                print(f"Error parsing line in {file_path}: {e}")
        
        cp_manager.update_checkpoint(file_path, new_offset, last_uuid)

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

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Aura Watcher")
    parser.add_argument("--logs-dir", required=True, help="Directory to watch for logs")
    parser.add_argument("--db-path", default="aura.duckdb", help="Path to DuckDB file")
    args = parser.parse_args()

    writer = DuckDBWriter(args.db_path)
    adapter = ClaudeAdapter()
    cp_manager = CheckpointManager(writer)

    handler = JSONLHandler(writer, adapter, cp_manager)
    observer = Observer()
    observer.schedule(handler, args.logs_dir, recursive=True)
    observer.start()

    print(f"Watching {args.logs_dir} for log changes...")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    main()
