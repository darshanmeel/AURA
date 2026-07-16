import getpass
import json
import logging
import os
from datetime import UTC, datetime

log = logging.getLogger(__name__)


def _load_people_config():
    config_path = os.path.expanduser("~/.aura/people.json")
    if os.path.exists(config_path):
        try:
            with open(config_path) as f:
                return json.load(f)
        except Exception as exc:
            log.warning("Could not load people config at %s: %s", config_path, exc)
    return {}


def _extract_session_title(file_path: str) -> str | None:
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            first_non_empty_seen = False
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except Exception:
                    continue

                # SDK trace detection: the FIRST non-empty line of an SDK trace
                # is a JSON object carrying a "kind" key. When we see it we
                # branch to the SDK title path (run_start.prompt) and never fall
                # through to the Claude logic — the two formats are disjoint.
                if not first_non_empty_seen:
                    first_non_empty_seen = True
                    if isinstance(raw, dict) and "kind" in raw:
                        return _sdk_title_from_trace(raw, f)

                if isinstance(raw, dict) and raw.get("type") == "user":
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
        pass
    return None


def _sdk_title_from_trace(first_raw: dict, fh) -> str | None:
    """Extract an SDK-trace session title from the run_start line's prompt.

    ``first_raw`` is the already-parsed first non-empty line; ``fh`` is the open
    file handle positioned just after it, so we can scan forward for run_start
    if the first line wasn't it. Title is the prompt truncated to 80 chars.
    """
    def _prompt_title(obj):
        if isinstance(obj, dict) and obj.get("kind") == "run_start":
            prompt = obj.get("prompt")
            if isinstance(prompt, str) and prompt.strip():
                return prompt.strip()[:80]
        return None

    title = _prompt_title(first_raw)
    if title is not None:
        return title

    # First line wasn't run_start (e.g. incremental layout) — scan a bounded
    # number of further lines for it before giving up.
    for _ in range(50):
        line = fh.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        title = _prompt_title(obj)
        if title is not None:
            return title
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


def backfill_session_attributes(writer, files: list[str], snapshot_lock) -> int:
    """Scan all JSONL files and upsert session_meta.{session_title, permission_mode, mode}.

    This handles files that are fully past their checkpoint offset — forward
    capture in process_file would miss their ai-title / permission-mode / mode
    records.  Scans ALL lines (cheap: parse + type check only; never inserts
    raw_events).  Last-seen-wins within each session across the full file list.

    Returns the number of upsert calls made (one per session that had at least
    one attribute record).
    """
    # Skip sessions already attributed by a prior run (forward-capture in
    # process_file or an earlier backfill). COALESCE makes a re-upsert harmless,
    # but rescanning the entire corpus on every restart is wasteful — a session
    # with permission_mode already recorded does not need its file re-scanned.
    already: set[str] = set()
    try:
        with snapshot_lock:
            with writer.get_connection() as conn:
                already = {
                    r[0]
                    for r in conn.execute(
                        "SELECT session_id FROM session_meta WHERE permission_mode IS NOT NULL"
                    ).fetchall()
                }
    except Exception as e:
        log.warning("[backfill_session_attributes] could not read existing attrs: %s", e)

    # Per-session accumulator: {session_id: {title, permission_mode, mode}}.
    per_session: dict[str, dict] = {}

    for f in files:
        # Derive session_id from filename (same convention as backfill_session_meta).
        session_id = os.path.splitext(os.path.basename(f))[0]
        if session_id in already:
            continue
        try:
            with open(f, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        raw = json.loads(line)
                    except Exception:
                        continue
                    if not isinstance(raw, dict):
                        continue
                    event_type = raw.get("type")
                    if event_type not in ("ai-title", "permission-mode", "mode"):
                        continue
                    # Use sessionId from the record when available, fall back to
                    # the filename-derived value (same logic as parse_session_attributes).
                    sid = raw.get("sessionId") or session_id
                    bucket = per_session.setdefault(sid, {})
                    if event_type == "ai-title":
                        title = raw.get("aiTitle")
                        if isinstance(title, str) and title:
                            bucket["title"] = title
                    elif event_type == "permission-mode":
                        perm = raw.get("permissionMode")
                        if isinstance(perm, str) and perm:
                            bucket["permission_mode"] = perm
                    elif event_type == "mode":
                        mode_val = raw.get("mode")
                        if isinstance(mode_val, str) and mode_val:
                            bucket["mode"] = mode_val
        except Exception as e:
            log.warning("[backfill_session_attributes] failed to scan %s: %s", f, e)

    if not per_session:
        return 0

    upserted = 0
    with snapshot_lock:
        for sid, attrs in per_session.items():
            if not attrs:
                continue
            try:
                writer.upsert_session_attributes(
                    sid,
                    title=attrs.get("title"),
                    permission_mode=attrs.get("permission_mode"),
                    mode=attrs.get("mode"),
                )
                upserted += 1
            except Exception as e:
                log.warning(
                    "[backfill_session_attributes] upsert failed for %s: %s", sid, e
                )
    return upserted
