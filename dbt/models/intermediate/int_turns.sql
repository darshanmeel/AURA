{{ config(materialized='view') }}

SELECT
    a.tenant_id,
    a.session_id,
    a.message_id as turn_id,
    u.uuid as user_event_uuid,
    a.uuid as assistant_event_uuid,
    u.ts as user_ts,
    a.ts as assistant_ts,
    -- Prompt and response texts
    json_extract_string(u.payload, '$.message.content') as user_prompt,
    json_extract_string(a.payload, '$.message.content[0].text') as assistant_response,
    a.cwd,
    a.git_branch,
    a.claude_version,
    a.model,
    a.input_tokens,
    a.output_tokens,
    a.cache_creation_input_tokens,
    a.ephemeral_5m_input_tokens,
    a.ephemeral_1h_input_tokens,
    a.cache_read_input_tokens,
    a.context_pct,
    a.is_sidechain
FROM {{ ref('stg_assistant_messages') }} a
LEFT JOIN {{ ref('stg_events') }} u
    ON a.parent_uuid = u.uuid AND a.tenant_id = u.tenant_id
