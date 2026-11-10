import hashlib
import json
import os
import re

# T8 (2026-07-16): IMPLEMENTED. Column-level masking for message/prompt content, gated
# behind AURA_HASH_CONTENT (default OFF — see adapters/claude.py's _HASH_CONTENT_ENABLED).
# When enabled, hash_message_content() replaces $.message.content (and $.message.content[N]
# .text) with `sha256:<hex>` markers AT INGEST TIME, before the payload is written to
# raw_events. This is the single choke point for all four sensitive downstream columns,
# because every one of them is extracted from that same payload path by dbt (not stored as
# its own raw_events column):
#   - user_prompt        (int_turns / dim_turn_messages) <- $.message.content /
#                                                            $.message.content[0..7].text
#   - assistant_response (int_turns / dim_turn_messages) <- $.message.content[0..19].text
#                                                            (type == 'text' blocks only)
#   - prompt_text_200    (fact_prompts)                  <- derived from user_prompt
#   - summary_200        (fact_prompts)                  <- derived from assistant_response
# Hashing only fires on ClaudeAdapter events — SdkTraceAdapter's payload shape never
# populates $.message.content (verified: sdk trace lines carry a top-level "content" key,
# not a nested "message" object), so those four columns are already NULL for sdk_trace rows
# regardless of this flag.
# Applies to NEW ingests only — existing raw_events rows are NOT retroactively rewritten.
# All other columns (token counts, costs, tool names, model ids, timestamps) are untouched —
# hash_message_content() targets only text-typed conversational content, never tool_use
# input, tool_result blocks, or thinking blocks.

# S5: the keyword may sit inside a longer name (aws_secret_access_key, AccountKey,
# GITHUB_TOKEN); the value is any run of 8+ non-space, non-quote characters.
# The whole match is replaced with «REDACTED» (W-H2). No leading [A-Za-z0-9_-]*
# before the keyword: on a long alphanumeric blob it backtracks quadratically.
_KEYWORD = r'(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|account[_-]?key|private[_-]?key)'
REDACT_REGEX = re.compile(r'(?i)' + _KEYWORD + r'[A-Za-z0-9_-]*["\']?\s*[:=]\s*["\']?[^\s"\']{8,}')
KEY_REGEX = re.compile(r'(?i)[A-Za-z0-9_-]*' + _KEYWORD + r'[A-Za-z0-9_-]*')
BEARER_REGEX = re.compile(r'Bearer\s+[A-Za-z0-9._~+/=-]{16,}')
URL_CREDS_REGEX = re.compile(r'\b[a-z][a-z0-9+.-]*://[^\s:/@]+:[^\s@]+@')

# W-L2: matches any long alphanumeric+base64-alphabet run (≥200 chars), not strictly
# valid base64; catches both padded base64 and unpadded hex/random blobs.
BASE64_REGEX = re.compile(r'[A-Za-z0-9+/]{200,}[=]{0,2}')

# W-H3: known credential formats, matched by their distinctive literal prefixes so
# ordinary identifiers / prose / SHAs / UUIDs (which have no such prefix) can't
# collide. Combined into one alternation — compiled once, one pass over the string.
# Word-boundary anchors (\b) keep these from matching mid-identifier substrings
# (e.g. "risk-adjusted" does not contain a \b before "sk-").
CREDENTIAL_REGEX = re.compile(
    r'\bAKIA[0-9A-Z]{16}\b'                                    # AWS access key ID
    r'|\bASIA[0-9A-Z]{16}\b'                                   # AWS temp (STS) access key ID
    r'|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b'           # GitHub tokens
    r'|\bgithub_pat_[A-Za-z0-9_]{22,}\b'                       # GitHub fine-grained PAT
    r'|\bsk-[A-Za-z0-9_-]{20,}\b'                               # OpenAI/Anthropic-style API keys (incl. sk-ant-...)
    r'|\bxox[baprs]-[A-Za-z0-9-]{10,}\b'                       # Slack tokens
    r'|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b'  # JWTs
)

# W-H3: PEM private key blocks, BEGIN through the matching END line. DOTALL so
# '.' spans the embedded newlines of the base64 body; non-greedy so a block
# stops at its own END line rather than swallowing a later, unrelated block.
PEM_REGEX = re.compile(
    r'-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----',
    re.DOTALL,
)

def redact_content(content: str) -> str:
    """Redact secrets and truncate long base64/alphanumeric blobs."""
    # Replace the entire key=value match with the redaction marker (spec §7).
    content = REDACT_REGEX.sub('«REDACTED»', content)
    content = BEARER_REGEX.sub('«REDACTED»', content)
    content = URL_CREDS_REGEX.sub('«REDACTED»', content)

    # Replace known credential-format tokens (whole match, consistent with W-H2).
    content = CREDENTIAL_REGEX.sub('«REDACTED»', content)

    # Replace PEM private key blocks (whole block, consistent with W-H2).
    content = PEM_REGEX.sub('«REDACTED»', content)

    # Truncate long alphanumeric runs that are likely base64 or binary blobs.
    def truncate_b64(m):
        val = m.group(0)
        return f"<base64:{len(val)} bytes>"

    content = BASE64_REGEX.sub(truncate_b64, content)
    return content


_REDACTED = '«REDACTED»'


def _secret_key(k, v) -> bool:
    return isinstance(v, str) and bool(v) and isinstance(k, str) and KEY_REGEX.fullmatch(k) is not None


def redact_obj(o):
    """Recursively apply redact_content() to every string in a nested
    dict/list/scalar structure and return the same structure.

    This must be called on the raw Python object BEFORE json.dumps() so that
    json.dumps() does all escaping AFTER redaction.  The previous pattern of
    redact_content(json.dumps(raw)) operated on the already-escaped JSON
    string, which caused BASE64_REGEX to match across JSON escape sequences
    (e.g. the 'n' of '\\n' followed by 200+ alphanum chars) and replace them
    with '<base64:N bytes>', leaving a dangling backslash that is an invalid
    JSON escape.  Redacting the Python object avoids this class of corruption
    entirely because json.dumps produces clean output after the fact.

    S5: a string value whose dict key names a secret (``{"password": "..."}``)
    is replaced whole, whatever its shape.
    """
    if isinstance(o, dict):
        return {k: _REDACTED if _secret_key(k, v) else redact_obj(v) for k, v in o.items()}
    if isinstance(o, list):
        return [redact_obj(item) for item in o]
    if isinstance(o, str):
        return redact_content(o)
    # int, float, bool, None — pass through unchanged.
    return o


def hash_text(text: str) -> str:
    """Return ``sha256:<64 hex chars>`` for `text`.

    Deterministic (same input -> same output), one-way (SHA-256 is not
    reversible). ``None`` is never passed here — callers guard for it.
    """
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def hash_message_content(raw: dict) -> dict:
    """T8: replace conversational text in ``raw['message']['content']`` with
    ``sha256:<hex>`` markers.

    Targets EXACTLY the JSON paths dbt's ``int_turns.sql`` extracts into
    ``user_prompt`` / ``assistant_response`` (and, downstream of those,
    ``fact_prompts.prompt_text_200`` / ``summary_200``):
      - ``$.message.content``         — plain string (user turns)
      - ``$.message.content[N].text`` — blocks where ``type == 'text'``
        (assistant turns; tool_use/thinking/tool_result blocks are left
        untouched so tool-call and cost analytics keep working)

    Call this AFTER redact_obj() (when redaction is also enabled) so the hash
    covers the REDACTED text, not a raw secret — hashing a leaked secret
    verbatim would still leave a fixed, guessable/rainbow-table-able digest
    for that exact secret value.

    Returns a NEW dict; `raw` is never mutated. Non-string / unexpected
    `content` shapes (missing message, missing content, non-str/non-list
    content) are returned unchanged — defensive, matches the "unknown shape
    passes through" pattern used by redact_obj.
    """
    message = raw.get("message")
    if not isinstance(message, dict) or "content" not in message:
        return raw

    content = message["content"]
    if isinstance(content, str):
        new_content: object = hash_text(content)
    elif isinstance(content, list):
        new_blocks = []
        for block in content:
            if (
                isinstance(block, dict)
                and block.get("type") == "text"
                and isinstance(block.get("text"), str)
            ):
                new_blocks.append({**block, "text": hash_text(block["text"])})
            else:
                new_blocks.append(block)
        new_content = new_blocks
    else:
        # Unexpected shape (None, dict, int, ...) — nothing text-shaped to
        # hash; leave the whole object unchanged rather than guessing.
        return raw

    return {**raw, "message": {**message, "content": new_content}}


def redact_enabled() -> bool:
    return os.getenv("AURA_REDACT_PAYLOAD", "true").lower() not in ("0", "false", "no", "off")


def hash_enabled() -> bool:
    return os.getenv("AURA_HASH_CONTENT", "false").lower() in ("1", "true")


def redact_payload(text: str) -> str:
    """Value-level redaction of a JSON payload string. ``text`` comes back
    unchanged when it is not valid JSON (no regex ever runs over JSON text, M2)."""
    try:
        obj = json.loads(text)
    except ValueError:
        return text
    return json.dumps(redact_obj(obj))


def redact_title(title: str | None) -> str | None:
    """S4: session titles get the same treatment as message text."""
    if not title:
        return title
    if redact_enabled():
        title = redact_content(title)
    return hash_text(title) if hash_enabled() else title
