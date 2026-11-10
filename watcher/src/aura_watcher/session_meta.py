import getpass
import json
import logging
import os

from aura_watcher.lake import utcnow
from aura_watcher.redact import redact_title

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


def session_meta_row(session_id: str, physical: str, logical: str) -> dict:
    """The one ``session_meta`` observation written when a file is first seen:
    the person running the watcher and the (redacted, S4) first-prompt title,
    read from the ``physical`` file. ``logical`` is the spec §2.6 path (unused)."""
    person_id, person_name = _resolve_person(_load_people_config())
    return {
        "tenant_id": "local",
        "session_id": session_id,
        "person_id": person_id,
        "person_name": person_name,
        "session_title": redact_title(_extract_session_title(physical)),
        "observed_at": utcnow(),
    }
