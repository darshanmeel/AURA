{{ config(materialized='view') }}

SELECT
    a.tenant_id,
    a.session_id,
    a.project_id,
    ROW_NUMBER() OVER (PARTITION BY a.tenant_id, a.session_id ORDER BY a.ts) AS turn_number,
    a.message_id as turn_id,
    u.uuid as user_event_uuid,
    a.uuid as assistant_event_uuid,
    u.ts as user_ts,
    a.ts as assistant_ts,
    -- Prompt: handle both plain-string content and content-block arrays.
    -- When content is an array we walk the first few blocks looking for a
    -- text block (skipping thinking and tool_result blocks). When content is
    -- a plain string the array lookups return NULL and we fall through.
    COALESCE(
        json_extract_string(u.payload, '$.message.content[0].text'),
        json_extract_string(u.payload, '$.message.content[1].text'),
        json_extract_string(u.payload, '$.message.content[2].text'),
        json_extract_string(u.payload, '$.message.content[3].text'),
        CASE
            WHEN starts_with(COALESCE(json_extract_string(u.payload, '$.message.content'), ''), '[')
                THEN NULL
            ELSE json_extract_string(u.payload, '$.message.content')
        END
    ) as user_prompt,
    -- Assistant response: same pattern. content[0].text covers the common case
    -- where the first block is text; fall through if it's thinking.
    COALESCE(
        json_extract_string(a.payload, '$.message.content[0].text'),
        json_extract_string(a.payload, '$.message.content[1].text'),
        json_extract_string(a.payload, '$.message.content[2].text'),
        json_extract_string(a.payload, '$.message.content[3].text')
    ) as assistant_response,
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
