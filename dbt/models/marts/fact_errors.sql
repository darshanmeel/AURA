{{ config(materialized='table') }}

-- Union of tool errors and assistant-side error stop_reasons, enriched with
-- a session-local turn_number and `resolved_in_turns`: the number of turns
-- between the error and the next assistant turn that performed an Edit or
-- Write tool call in the same session. NULL = never resolved within the
-- captured session window (caller may interpret as "still open").
-- Errors map to turns by (tenant_id, message_id): a message is streamed as
-- several events, and only one of their uuids is the turn's assistant_event_uuid.

WITH raw_errors AS (
    SELECT
        fte.tenant_id,
        fte.session_id,
        fte.tool_call_ts                                                AS ts,
        'tool_error'                                                    AS kind,
        fte.tool_name                                                   AS tool,
        left(fte.output_text, 200)                                      AS message,
        'warn'                                                          AS severity,
        fte.message_id
    FROM {{ ref('fact_tool_executions') }} fte
    WHERE fte.is_error = TRUE

    UNION ALL

    SELECT
        e.tenant_id,
        e.session_id,
        e.ts,
        e.stop_reason                                                   AS kind,
        NULL                                                            AS tool,
        NULL                                                            AS message,
        CASE e.stop_reason WHEN 'max_tokens' THEN 'warn' ELSE 'info' END AS severity,
        e.message_id
    FROM {{ ref('stg_events') }} e
    WHERE e.event_type = 'assistant'
      AND e.stop_reason IN ('max_tokens', 'refusal')
),
errors_with_turn AS (
    SELECT
        re.*,
        ft.turn_number                                                  AS turn_number
    FROM raw_errors re
    LEFT JOIN {{ ref('fact_turns') }} ft
        ON ft.tenant_id = re.tenant_id AND ft.turn_id = re.message_id
),
-- For every session, find the turn_number of each Edit/Write tool call.
edit_turns AS (
    SELECT DISTINCT
        ft.tenant_id,
        ft.session_id,
        ft.turn_number
    FROM {{ ref('fact_tool_executions') }} fte
    JOIN {{ ref('fact_turns') }} ft
        ON ft.tenant_id = fte.tenant_id AND ft.turn_id = fte.message_id
    WHERE fte.tool_name IN ('Edit', 'Write')
      AND COALESCE(fte.is_error, FALSE) = FALSE
),
-- For each error turn, find the smallest edit_turn strictly greater.
resolution AS (
    SELECT
        ewt.tenant_id,
        ewt.session_id,
        ewt.ts,
        ewt.kind,
        ewt.tool,
        ewt.message,
        ewt.severity,
        ewt.turn_number,
        MIN(et.turn_number) - ewt.turn_number                           AS resolved_in_turns
    FROM errors_with_turn ewt
    LEFT JOIN edit_turns et
        ON et.tenant_id = ewt.tenant_id
       AND et.session_id = ewt.session_id
       AND ewt.turn_number IS NOT NULL
       AND et.turn_number > ewt.turn_number
    GROUP BY
        ewt.tenant_id, ewt.session_id, ewt.ts, ewt.kind, ewt.tool,
        ewt.message, ewt.severity, ewt.turn_number
)
SELECT
    tenant_id,
    session_id,
    ts,
    kind,
    tool,
    message,
    severity,
    turn_number,
    resolved_in_turns
FROM resolution
