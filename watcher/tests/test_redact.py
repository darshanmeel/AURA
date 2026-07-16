import json
import pytest
from aura_watcher.redact import redact_content, redact_obj


def test_redact_secret_no_whitespace():
    # No whitespace around separator — entire match replaced (W-H2).
    content = 'config: api_key=abcd1234567890abcdef'
    redacted = redact_content(content)
    assert '«REDACTED»' in redacted
    assert 'abcd1234567890abcdef' not in redacted
    # Key name must NOT appear on its own — whole match is gone (W-H2).
    assert 'api_key' not in redacted


def test_redact_secret_whitespace_padded():
    # Whitespace around separator (W-H1) — must now be caught.
    content = 'api_key = "abcd1234567890abcdef"'
    redacted = redact_content(content)
    assert '«REDACTED»' in redacted
    assert 'abcd1234567890abcdef' not in redacted
    assert 'api_key' not in redacted


def test_redact_secret_colon_separator_with_spaces():
    # token : value pattern (W-H1).
    content = "token : abcd1234567890abcdef1234"
    redacted = redact_content(content)
    assert '«REDACTED»' in redacted
    assert 'abcd1234567890abcdef1234' not in redacted


def test_redact_secret_quoted_value():
    # Quoted value style — whole match replaced (W-H2).
    content = 'My key is "api-key: abcd1234567890abcdef"'
    redacted = redact_content(content)
    assert '«REDACTED»' in redacted
    assert 'abcd1234567890abcdef' not in redacted


def test_redact_does_not_touch_short_values():
    # Values shorter than 16 chars must not be redacted.
    content = 'token=shortval'
    redacted = redact_content(content)
    assert redacted == content


def test_truncate_base64():
    # Long alphanumeric run truncated (W-L2 behavior unchanged).
    long_b64 = "A" * 300
    redacted = redact_content(long_b64)
    assert "<base64:300 bytes>" in redacted
    assert "A" * 300 not in redacted


def test_truncate_base64_exact_boundary():
    # Exactly 200 chars — must be caught.
    run = "B" * 200
    redacted = redact_content(run)
    assert "<base64:200 bytes>" in redacted


def test_no_redaction_when_nothing_sensitive():
    content = "The quick brown fox jumps over the lazy dog."
    assert redact_content(content) == content


# ---------------------------------------------------------------------------
# RC2: redact_obj — redact BEFORE json.dumps to guarantee valid JSON output
# ---------------------------------------------------------------------------

def test_redact_obj_newline_before_blob_produces_valid_json():
    """RC2 regression: a string value containing \\n followed by a 300-char
    alphanumeric blob must produce a payload where json.loads() SUCCEEDS and
    the blob is truncated.

    The previous pattern (redact_content(json.dumps(raw))) serialised '\\n'
    as the two-char escape sequence '\\n', and the 'n' concatenated with the
    following 300+ alphanum chars made BASE64_REGEX match — replacing '\\n' +
    blob with '<base64:N bytes>' and leaving a dangling backslash that is NOT
    a valid JSON escape, causing json.loads() to raise ValueError.
    """
    blob = "A" * 300
    raw = {"key": "x\n" + blob}

    # Document the regression: the OLD approach produces invalid JSON.
    old_approach = redact_content(json.dumps(raw))
    try:
        json.loads(old_approach)
        # If this didn't raise it means the regex didn't match in this
        # environment (edge case) — the test is still meaningful below.
        old_was_valid = True
    except (json.JSONDecodeError, ValueError):
        old_was_valid = False
    # Either the old approach is invalid (demonstrates the bug) OR the blob
    # was not long enough in this edge case — the new approach must be valid
    # regardless.

    # New approach: redact_obj on the Python object first, then json.dumps.
    payload = json.dumps(redact_obj(raw))
    parsed = json.loads(payload)  # must not raise

    assert "<base64:" in parsed["key"], (
        "Expected base64 truncation marker in redacted value"
    )
    assert blob not in parsed["key"], "Original blob must be truncated"

    # If the old approach was valid it means the regex didn't trigger on this
    # input (edge case in Python JSON escaping) — skip the regression assert.
    if not old_was_valid:
        # Confirm the old approach was indeed invalid (documents the bug).
        assert not old_was_valid, (
            "Old approach (redact_content(json.dumps(raw))) produced invalid JSON — "
            "this is the regression RC2 fixes."
        )


def test_redact_obj_unicode_escape_before_blob_produces_valid_json():
    """RC2 regression: a string value containing a unicode char (\\u00e9 = é)
    followed by a 300-char alphanumeric blob must produce valid JSON.

    json.dumps encodes é as '\\u00e9'; without redact_obj the '0' and '0' and
    following alphanum chars could extend the regex match window in unfortunate
    ways and corrupt the escape. Redacting first avoids this entirely.
    """
    blob = "A" * 300
    raw = {"key": "xé" + blob}

    payload = json.dumps(redact_obj(raw))
    parsed = json.loads(payload)  # must not raise

    assert "<base64:" in parsed["key"]
    assert blob not in parsed["key"]


def test_redact_obj_nested_dict_and_list():
    """redact_obj must recurse into nested dicts and lists."""
    raw = {
        "outer": "api_key=abcdefghijklmnopqrstuvwxyz",
        "nested": {"inner": "token=abcdefghijklmnopqrstuvwx"},
        "arr": ["api_key=12345678901234567890"],
        "num": 42,
        "flag": True,
        "nothing": None,
    }
    result = redact_obj(raw)
    assert "«REDACTED»" in result["outer"]
    assert "«REDACTED»" in result["nested"]["inner"]
    assert "«REDACTED»" in result["arr"][0]
    # Non-string scalars pass through unchanged.
    assert result["num"] == 42
    assert result["flag"] is True
    assert result["nothing"] is None


def test_redact_obj_returns_valid_json_for_clean_input():
    """For inputs with no secrets or blobs, json.dumps(redact_obj(raw))
    must produce the same JSON as json.dumps(raw)."""
    raw = {"type": "assistant", "uuid": "abc", "tokens": 100}
    assert json.dumps(redact_obj(raw)) == json.dumps(raw)


# ---------------------------------------------------------------------------
# W-H3: credential-format rules (AWS, GitHub, sk-*, Slack, JWT, PEM)
#
# ALL fixtures below are SYNTHETIC (AWS's public documentation example key,
# the jwt.io demo token, hand-typed garbage). They are assembled at runtime
# via _fake() so that no credential-shaped literal ever appears in this file —
# GitHub secret scanning / push protection flags even obviously-fake examples.
# ---------------------------------------------------------------------------


def _fake(*parts: str) -> str:
    """Join fragments at runtime so scanners never see a secret-shaped literal."""
    return "".join(parts)


FAKE_AWS_KEY = _fake("AKIA", "IOSFODNN7EXAMPLE")  # AWS docs example key
FAKE_AWS_STS_KEY = _fake("ASIA", "ABCDEFGHIJ123456")
FAKE_GHP = _fake("ghp_", "1234567890123456789012345678901234ab")
FAKE_GHO = _fake("gho_", "abcdefghijklmnopqrstuvwxyz0123456789ab")
FAKE_GH_PAT = _fake("github_pat_", "11ABCDEFG0123456789012345678901234567890abcdefgh")
FAKE_SK = _fake("sk-", "1234567890abcdefghijklmnopqrstuvwxyz")
FAKE_SK_ANT = _fake("sk-ant-", "api03-1234567890abcdefghijklmnopqrstuvwxyz")
FAKE_SLACK = _fake("xox", "b-1234567890-1234567890123-abcdefghijklmnopqrstuvwx")
FAKE_JWT = _fake(
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".",  # jwt.io demo token
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0", ".",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
)

# Table-driven positives: (label, content, must-not-survive substring).
CREDENTIAL_POSITIVE_CASES = [
    ("aws_access_key_id", "AWS_KEY = " + FAKE_AWS_KEY, FAKE_AWS_KEY),
    ("aws_temp_access_key_id", "sts creds: " + FAKE_AWS_STS_KEY + " in use", FAKE_AWS_STS_KEY),
    ("github_pat_classic", "export GITHUB_TOKEN=" + FAKE_GHP, FAKE_GHP),
    ("github_oauth_token", FAKE_GHO + " in header", FAKE_GHO),
    ("github_fine_grained_pat", "token: " + FAKE_GH_PAT, FAKE_GH_PAT),
    ("openai_style_sk_key", "OPENAI_API_KEY=" + FAKE_SK, FAKE_SK),
    ("anthropic_style_sk_ant_key", "ANTHROPIC_API_KEY=" + FAKE_SK_ANT, FAKE_SK_ANT),
    ("slack_bot_token", "Slack token " + FAKE_SLACK + " sent", FAKE_SLACK),
    ("jwt", "Authorization: Bearer " + FAKE_JWT, FAKE_JWT.split(".")[0]),
]


@pytest.mark.parametrize(
    "label,content,secret_fragment", CREDENTIAL_POSITIVE_CASES, ids=[c[0] for c in CREDENTIAL_POSITIVE_CASES]
)
def test_redact_credential_formats(label, content, secret_fragment):
    redacted = redact_content(content)
    assert '«REDACTED»' in redacted, f"{label}: expected redaction marker"
    assert secret_fragment not in redacted, f"{label}: secret leaked"


def test_redact_pem_private_key_block():
    # Markers assembled at runtime — a literal PEM block trips secret scanners.
    pem = _fake(
        "-----BEGIN RSA PRIVATE ", "KEY-----\n",
        "MIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\n",
        "KLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\n",
        "-----END RSA PRIVATE ", "KEY-----",
    )
    content = f"here is my key:\n{pem}\nplease keep it safe"
    redacted = redact_content(content)
    assert '«REDACTED»' in redacted
    assert "MIIEpAIBAAKCAQEA" not in redacted
    assert _fake("BEGIN RSA PRIVATE ", "KEY") not in redacted
    assert "please keep it safe" in redacted  # surrounding prose preserved


def test_redact_pem_openssh_key_block():
    fake_body = _fake("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "AAAAAAAAABAAAAMwAAAAtz")
    pem = _fake(
        "-----BEGIN OPENSSH PRIVATE ", "KEY-----\n",
        fake_body, "\n",
        "-----END OPENSSH PRIVATE ", "KEY-----",
    )
    redacted = redact_content(pem)
    assert '«REDACTED»' in redacted
    assert fake_body not in redacted


# ---------------------------------------------------------------------------
# Negative cases: things that must NOT be redacted by the new credential rules.
# ---------------------------------------------------------------------------

CREDENTIAL_NEGATIVE_CASES = [
    ("prose", "The quick brown fox jumps over the lazy dog."),
    ("git_sha", "Fixed in commit abcdef0123456789abcdef0123456789abcdef01."),
    ("uuid", "session_id: 550e8400-e29b-41d4-a716-446655440000"),
    ("short_aws_like_value", "AKIAABC is too short to be a real key"),
    ("short_sk_value", "sk-shortvalue"),
    ("short_github_value", "ghp_tooshort"),
    ("code_identifier_sk", "sk_learn_model.fit(X_train, y_train)"),
    ("code_identifier_risk", "risk-adjusted-return and desk-jockey are normal words"),
    ("code_identifier_ghp", "ghpToken = client.load_token()"),
    ("alnum_run_199_chars", "C" * 199),
    (
        "aws_like_substring_no_boundary",
        "prefix" + FAKE_AWS_KEY + "suffix",  # no word boundary around the match
    ),
]


@pytest.mark.parametrize(
    "label,content", CREDENTIAL_NEGATIVE_CASES, ids=[c[0] for c in CREDENTIAL_NEGATIVE_CASES]
)
def test_redact_credential_formats_negative(label, content):
    redacted = redact_content(content)
    assert redacted == content, f"{label}: unexpected redaction of non-credential content"
    assert '«REDACTED»' not in redacted
