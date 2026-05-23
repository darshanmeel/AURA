{{ config(materialized='table') }}

SELECT
    session_id,
    tool_call_ts                                                     AS ts,
    'tool_error'                                                     AS kind,
    tool_name                                                        AS tool,
    left(output_text, 200)                                           AS message,
    'warn'                                                           AS severity,
    NULL::INTEGER                                                    AS turn_number
FROM {{ ref('fact_tool_executions') }}
WHERE is_error = true

UNION ALL

SELECT
    session_id,
    ts,
    stop_reason                                                      AS kind,
    NULL                                                             AS tool,
    NULL                                                             AS message,
    CASE stop_reason WHEN 'max_tokens' THEN 'warn' ELSE 'info' END  AS severity,
    NULL::INTEGER                                                    AS turn_number
FROM {{ ref('stg_events') }}
WHERE event_type = 'assistant'
  AND stop_reason IN ('max_tokens', 'refusal')
