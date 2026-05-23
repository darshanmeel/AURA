{{ config(materialized='view') }}

WITH ranked AS (
    SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY tenant_id, message_id ORDER BY ts DESC, byte_offset DESC) as rn
    FROM {{ ref('stg_events') }}
    WHERE event_type = 'assistant' AND message_id IS NOT NULL
)
SELECT
    tenant_id,
    uuid,
    session_id,
    project_id,
    agent,
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
    payload
FROM ranked
WHERE rn = 1
