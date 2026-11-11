{{ config(materialized='view') }}

-- One row per thinking block inside an assistant message.
-- The `thinking` text is often redacted to "<base64:N bytes>" when
-- AURA_REDACT_PAYLOAD is set; downstream consumers should treat empty /
-- redacted text as not-available rather than missing data.
SELECT
    tenant_id,
    session_id,
    event_uuid                                              AS assistant_event_uuid,
    ts,
    model,
    is_sidechain,
    ROW_NUMBER() OVER (
        PARTITION BY tenant_id, event_uuid
        ORDER BY block_idx
    ) - 1                                                   AS thinking_idx,
    thinking                                                AS thinking_text,
    signature
FROM {{ ref('stg_content_blocks') }}
WHERE event_type = 'assistant' AND block_type = 'thinking'
