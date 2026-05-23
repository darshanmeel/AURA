{{ config(materialized='table') }}

SELECT
    tc.tenant_id,
    tc.session_id,
    tc.event_uuid as assistant_event_uuid,
    tc.tool_use_id,
    tc.ts as tool_call_ts,
    tr.ts as tool_result_ts,
    tc.model,
    tc.tool_name,
    tc.input_payload,
    tr.output_text,
    COALESCE(tr.is_error, FALSE) as is_error,
    date_diff('millisecond', tc.ts, tr.ts) / 1000.0 as execution_duration_seconds
FROM {{ ref('stg_tool_calls') }} tc
LEFT JOIN {{ ref('stg_tool_results') }} tr
    ON tc.tool_use_id = tr.tool_use_id AND tc.tenant_id = tr.tenant_id
