import json
import os
import getpass
from datetime import datetime, UTC


def _load_people_config():
    config_path = os.path.expanduser("~/.aura/people.json")
    if os.path.exists(config_path):
        try:
            with open(config_path) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _extract_session_title(file_path: str) -> str | None:
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                    if raw.get("type") == "user":
                        msg = raw.get("message", {})
                        content = msg.get("content", "")
                        if isinstance(content, str) and content.strip():
                            return content.strip()[:80]
                        if isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict) and block.get("type") == "text":
                                    text = block.get("text", "").strip()
                                    if text:
                                        return text[:80]
                except Exception:
                    continue
    except Exception:
        pass
    return None


def ensure_session_meta_table(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS session_meta (
            session_id    TEXT PRIMARY KEY,
            tenant_id     TEXT NOT NULL DEFAULT 'local',
            person_id     TEXT,
            person_name   TEXT,
            commits       INTEGER DEFAULT 0,
            session_title TEXT,
            ingested_at   TIMESTAMP DEFAULT now()
        )
    """)


def write_session_meta(writer, session_id: str, file_path: str, tenant_id: str = "local"):
    person_id = getpass.getuser()
    people = _load_people_config()
    person_info = people.get(person_id, {})
    person_name = person_info.get("name", getpass.getuser())
    session_title = _extract_session_title(file_path)

    with writer.get_connection() as conn:
        ensure_session_meta_table(conn)
        conn.execute("""
            INSERT INTO session_meta (session_id, tenant_id, person_id, person_name, session_title, ingested_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (session_id) DO NOTHING
        """, [session_id, tenant_id, person_id, person_name, session_title, datetime.now(UTC)])
