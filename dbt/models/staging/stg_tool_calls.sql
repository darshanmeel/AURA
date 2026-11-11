{{ config(materialized='table') }}
-- A table: fact_tool_executions, int_event_agent and stg_tool_results all read it.

SELECT
    tenant_id,
    event_uuid,
    session_id,
    -- message_id: one assistant message is streamed as several events; joins
    -- to fact_turns go through message_id, not the (non-winning) event uuid.
    message_id,
    cwd,
    ts,
    model,
    tool_use_id,
    tool_name,
    tool_input AS input_payload
FROM {{ ref('stg_content_blocks') }}
WHERE event_type = 'assistant' AND block_type = 'tool_use'
-- Claude Code can write the same tool_use under two event uuids (same message, same ts).
QUALIFY ROW_NUMBER() OVER (PARTITION BY tenant_id, tool_use_id ORDER BY ts, event_uuid) = 1
