{{ config(materialized='view') }}

-- One row per thinking block inside an assistant message.
-- Mirrors the unnest pattern used by stg_tool_calls.
-- The `thinking` text is often redacted to "<base64:N bytes>" when
-- AURA_REDACT_PAYLOAD is set; downstream consumers should treat empty /
-- redacted text as not-available rather than missing data.

WITH exploded AS (
    SELECT
        tenant_id,
        uuid as assistant_event_uuid,
        session_id,
        ts,
        model,
        is_sidechain,
        UNNEST(CAST(json_extract(payload, '$.message.content') AS JSON[])) as content_item
    FROM {{ ref('stg_events') }}
    WHERE event_type = 'assistant'
      AND payload LIKE '%"type":"thinking"%'
),
filtered AS (
    SELECT
        tenant_id,
        session_id,
        assistant_event_uuid,
        ts,
        model,
        is_sidechain,
        content_item
    FROM exploded
    WHERE json_extract_string(content_item, '$.type') = 'thinking'
)
SELECT
    tenant_id,
    session_id,
    assistant_event_uuid,
    ts,
    model,
    is_sidechain,
    ROW_NUMBER() OVER (
        PARTITION BY tenant_id, assistant_event_uuid
        ORDER BY ts
    ) - 1                                                   AS thinking_idx,
    json_extract_string(content_item, '$.thinking')         AS thinking_text,
    json_extract_string(content_item, '$.signature')        AS signature
FROM filtered
