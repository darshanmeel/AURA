import re

# TODO (pre-central-deployment): Add column-level masking for message/prompt content before
# any outbound sync to a central server. Specifically, the following fields must be hashed
# (SHA-256) or nulled so only the individual user can see their own conversation content:
#   - user_prompt        (int_turns / fact_turns)
#   - assistant_response (int_turns / fact_turns)
#   - prompt_text_200    (fact_prompts)
#   - summary_200        (fact_prompts)
# All other columns (token counts, costs, tool names, timestamps) are safe to aggregate.

REDACT_REGEX = re.compile(r'(?i)(api[_-]?key|secret|token|password)[\" \']?[:=][\" \']?([A-Za-z0-9_\-]{16,})')
BASE64_REGEX = re.compile(r'[A-Za-z0-9+/]{200,}[=]{0,2}')

def redact_content(content: str) -> str:
    """Redact secrets and truncate long base64 strings."""
    # Redact secrets
    content = REDACT_REGEX.sub(lambda m: f"{m.group(1)}: «REDACTED»", content)
    
    # Truncate base64
    def truncate_b64(m):
        val = m.group(0)
        return f"<base64:{len(val)} bytes>"
    
    content = BASE64_REGEX.sub(truncate_b64, content)
    return content
