{{ config(materialized='view') }}

SELECT
    tenant_id,
    uuid,
    session_id,
    -- project_id does not exist in raw_events; derived downstream via dim_apps (cwd parsing)
    NULL::VARCHAR  AS project_id,
    agent,
    source,
    reported_cost_usd,
    event_type,
    ts,
    file_path,
    byte_offset,
    parent_uuid,
    request_id,
    message_id,
    is_sidechain,
    stop_reason,
    cwd,
    git_branch,
    claude_version,
    model,
    input_tokens,
    output_tokens,
    cache_creation_input_tokens,
    ephemeral_5m_input_tokens,
    ephemeral_1h_input_tokens,
    cache_read_input_tokens,
    context_pct,
    -- Guard against historically corrupted rows whose payload is invalid JSON.
    -- TRY_CAST returns NULL for any payload that does not parse as JSON;
    -- json_extract_string(NULL, '$.x') returns NULL without throwing, so all
    -- downstream models continue to work and only the JSON-derived fields go
    -- null for the corrupt row (the row itself is preserved).
    CASE WHEN TRY_CAST(payload AS JSON) IS NOT NULL THEN payload END AS payload
FROM {{ source('aura', 'raw_events') }}
