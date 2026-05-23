from aura_watcher.redact import redact_content

def test_redact_secrets():
    content = 'My key is "api-key: abcd1234567890abcdef"'
    redacted = redact_content(content)
    assert '«REDACTED»' in redacted
    assert 'abcd1234567890abcdef' not in redacted

def test_truncate_base64():
    long_b64 = "A" * 300
    redacted = redact_content(long_b64)
    assert "<base64:" in redacted
