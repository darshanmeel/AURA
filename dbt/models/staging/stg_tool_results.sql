{{ config(materialized='view') }}

WITH unioned_results AS (
    -- Case 1: Unnested content array (type = 'tool_result')
    SELECT
        tenant_id,
        uuid as event_uuid,
        session_id,
        ts,
        json_extract_string(content_item, '$.tool_use_id') as tool_use_id,
        json_extract_string(content_item, '$.content') as output_text,
        json_extract_string(content_item, '$.is_error') = 'true' as is_error
    FROM {{ ref('stg_events') }},
    UNNEST(CAST(json_extract(payload, '$.message.content') AS JSON[])) as t(content_item)
    WHERE event_type = 'user' AND payload LIKE '%"type": "tool_result"%'
      AND json_extract_string(content_item, '$.type') = 'tool_result'

    UNION ALL

    -- Case 2: Top-level toolUseResult
    SELECT
        e.tenant_id,
        e.uuid as event_uuid,
        e.session_id,
        e.ts,
        tc.tool_use_id as tool_use_id,
        json_extract_string(e.payload, '$.toolUseResult.text') as output_text,
        COALESCE(json_extract_string(e.payload, '$.toolUseResult.isError') = 'true', FALSE) as is_error
    FROM {{ ref('stg_events') }} e
    LEFT JOIN {{ ref('stg_tool_calls') }} tc
        ON tc.event_uuid = json_extract_string(e.payload, '$.sourceToolAssistantUUID')
    WHERE e.event_type = 'user' AND json_extract(e.payload, '$.toolUseResult') IS NOT NULL
)
SELECT * FROM unioned_results
