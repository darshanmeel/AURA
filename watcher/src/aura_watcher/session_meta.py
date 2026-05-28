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


def _resolve_person(people: dict) -> tuple[str, str]:
    """Resolve (person_id, person_name) using this priority:
      1) AURA_DEFAULT_PERSON_ID env var (override — useful in containers
         where getpass.getuser() returns 'root' instead of the human).
      2) getpass.getuser() (the OS user running the watcher).
    The name comes from ~/.aura/people.json keyed by person_id, falling
    back to AURA_DEFAULT_PERSON_NAME, then to person_id itself.
    """
    person_id = os.getenv("AURA_DEFAULT_PERSON_ID") or getpass.getuser()
    person_info = people.get(person_id, {})
    person_name = (
        person_info.get("name")
        or os.getenv("AURA_DEFAULT_PERSON_NAME")
        or person_id
    )
    return person_id, person_name


def write_session_meta(writer, session_id: str, file_path: str, tenant_id: str = "local"):
    people = _load_people_config()
    person_id, person_name = _resolve_person(people)
    session_title = _extract_session_title(file_path)

    with writer.get_connection() as conn:
        ensure_session_meta_table(conn)
        conn.execute("""
            INSERT INTO session_meta (session_id, tenant_id, person_id, person_name, session_title, ingested_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (session_id) DO NOTHING
        """, [session_id, tenant_id, person_id, person_name, session_title, datetime.now(UTC)])


def backfill_session_meta(writer, files: list[str], snapshot_lock, tenant_id: str = "local"):
    """Bulk-fill session_meta for files whose session_id has no row yet.

    Holds snapshot_lock for the full scan so dbt / snapshot workers don't
    race with us on the DuckDB file lock. Uses a single connection across
    all sessions — opening one connection per file (the original loop in
    main.py) lost ~95% of sessions to 'Conflicting lock' errors.
    """
    people = _load_people_config()
    person_id, person_name = _resolve_person(people)
    now = datetime.now(UTC)

    seen: set = set()
    written = 0
    skipped_existing = 0
    with snapshot_lock:
        with writer.get_connection() as conn:
            ensure_session_meta_table(conn)
            existing = {
                row[0] for row in conn.execute(
                    "SELECT session_id FROM session_meta"
                ).fetchall()
            }
            for f in files:
                # JSONL layout: /logs/claude/<project_dir>/<session_id>.jsonl
                # The session_id IS the filename (sans .jsonl). The old code
                # used basename(dirname(...)) which returned the project dir
                # — that's why session_meta only ever got 18 rows (= distinct
                # project dirs) and dim_sessions LEFT JOIN found nothing.
                session_id = os.path.splitext(os.path.basename(f))[0]
                if session_id in seen:
                    continue
                seen.add(session_id)
                if session_id in existing:
                    skipped_existing += 1
                    continue
                title = _extract_session_title(f)
                try:
                    conn.execute(
                        """
                        INSERT INTO session_meta (
                            session_id, tenant_id, person_id, person_name,
                            session_title, ingested_at
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT (session_id) DO NOTHING
                        """,
                        [session_id, tenant_id, person_id, person_name, title, now],
                    )
                    written += 1
                except Exception as e:
                    print(f"[session_meta] insert failed for {session_id}: {e}")
    return written, skipped_existing
