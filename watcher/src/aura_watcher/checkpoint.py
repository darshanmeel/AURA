from datetime import datetime, UTC

class CheckpointManager:
    def __init__(self, writer):
        self.writer = writer

    def get_checkpoint(self, file_path: str, tenant_id: str = 'local'):
        with self.writer.get_connection() as conn:
            row = conn.execute(
                "SELECT last_offset, last_line_uuid FROM ingest_checkpoints WHERE tenant_id = ? AND file_path = ?",
                [tenant_id, file_path]
            ).fetchone()
            if row:
                return {"last_offset": row[0], "last_line_uuid": row[1]}
            return {"last_offset": 0, "last_line_uuid": None}

    def update_checkpoint(self, file_path: str, offset: int, uuid: str, tenant_id: str = 'local'):
        with self.writer.get_connection() as conn:
            conn.execute("""
                INSERT OR REPLACE INTO ingest_checkpoints 
                (tenant_id, file_path, last_offset, last_line_uuid, last_seen_at)
                VALUES (?, ?, ?, ?, ?)
            """, [tenant_id, file_path, offset, uuid, datetime.now(UTC)])
