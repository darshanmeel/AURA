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
    -- Try plain string first (most common for external prompts), then walk
    -- up to 8 array positions for the first text block. This covers user
    -- messages where several tool_result blocks precede the actual text.
    -- NOTE: a proper fix would use list_filter + unnest to avoid the fixed
    -- depth limit, but 8 positions covers the vast majority of real sessions.
    COALESCE(
        -- Plain string content (no leading '[')
        CASE
            WHEN NOT starts_with(COALESCE(json_extract_string(u.payload, '$.message.content'), ''), '[')
            THEN json_extract_string(u.payload, '$.message.content')
        END,
        json_extract_string(u.payload, '$.message.content[0].text'),
        json_extract_string(u.payload, '$.message.content[1].text'),
        json_extract_string(u.payload, '$.message.content[2].text'),
        json_extract_string(u.payload, '$.message.content[3].text'),
        json_extract_string(u.payload, '$.message.content[4].text'),
        json_extract_string(u.payload, '$.message.content[5].text'),
        json_extract_string(u.payload, '$.message.content[6].text'),
        json_extract_string(u.payload, '$.message.content[7].text')
    ) as user_prompt,
    -- Assistant response: walk up to 8 array positions for the first text
    -- block (skipping thinking blocks that may appear before the text block).
    -- NOTE: a proper fix would use list_filter + unnest.
    COALESCE(
        json_extract_string(a.payload, '$.message.content[0].text'),
        json_extract_string(a.payload, '$.message.content[1].text'),
        json_extract_string(a.payload, '$.message.content[2].text'),
        json_extract_string(a.payload, '$.message.content[3].text'),
        json_extract_string(a.payload, '$.message.content[4].text'),
        json_extract_string(a.payload, '$.message.content[5].text'),
        json_extract_string(a.payload, '$.message.content[6].text'),
        json_extract_string(a.payload, '$.message.content[7].text')
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
