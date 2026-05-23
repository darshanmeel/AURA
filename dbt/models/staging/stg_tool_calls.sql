{{ config(materialized='view') }}

WITH exploded AS (
    SELECT
        tenant_id,
        uuid as event_uuid,
        session_id,
        ts,
        model,
        UNNEST(CAST(json_extract(payload, '$.message.content') AS JSON[])) as content_item
    FROM {{ ref('stg_events') }}
    WHERE event_type = 'assistant' AND payload LIKE '%"type": "tool_use"%'
)
SELECT
    tenant_id,
    event_uuid,
    session_id,
    ts,
    model,
    json_extract_string(content_item, '$.id') as tool_use_id,
    json_extract_string(content_item, '$.name') as tool_name,
    json_extract(content_item, '$.input') as input_payload
FROM exploded
WHERE json_extract_string(content_item, '$.type') = 'tool_use'
