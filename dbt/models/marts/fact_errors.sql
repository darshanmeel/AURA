{{ config(materialized='table') }}

-- Union of tool errors and assistant-side error stop_reasons, enriched with
-- a session-local turn_number and `resolved_in_turns`: the number of turns
-- between the error and the next assistant turn that performed an Edit or
-- Write tool call in the same session. NULL = never resolved within the
-- captured session window (caller may interpret as "still open").

WITH raw_errors AS (
    SELECT
        fte.session_id,
        fte.tool_call_ts                                                AS ts,
        'tool_error'                                                    AS kind,
        fte.tool_name                                                   AS tool,
        left(fte.output_text, 200)                                      AS message,
        'warn'                                                          AS severity,
        fte.assistant_event_uuid                                        AS source_assistant_uuid
    FROM {{ ref('fact_tool_executions') }} fte
    WHERE fte.is_error = TRUE

    UNION ALL

    SELECT
        e.session_id,
        e.ts,
        e.stop_reason                                                   AS kind,
        NULL                                                            AS tool,
        NULL                                                            AS message,
        CASE e.stop_reason WHEN 'max_tokens' THEN 'warn' ELSE 'info' END AS severity,
        e.uuid                                                          AS source_assistant_uuid
    FROM {{ ref('stg_events') }} e
    WHERE e.event_type = 'assistant'
      AND e.stop_reason IN ('max_tokens', 'refusal')
),
-- Map each error to the turn it occurred in (via assistant_event_uuid).
errors_with_turn AS (
    SELECT
        re.*,
        ft.turn_number                                                  AS turn_number
    FROM raw_errors re
    LEFT JOIN {{ ref('fact_turns') }} ft
        ON ft.assistant_event_uuid = re.source_assistant_uuid
),
-- For every session, find the turn_number of each Edit/Write tool call.
edit_turns AS (
    SELECT DISTINCT
        ft.session_id,
        ft.turn_number
    FROM {{ ref('fact_tool_executions') }} fte
    JOIN {{ ref('fact_turns') }} ft
        ON ft.assistant_event_uuid = fte.assistant_event_uuid
    WHERE fte.tool_name IN ('Edit', 'Write')
      AND COALESCE(fte.is_error, FALSE) = FALSE
),
-- For each error turn, find the smallest edit_turn strictly greater.
resolution AS (
    SELECT
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
        ON et.session_id = ewt.session_id
       AND ewt.turn_number IS NOT NULL
       AND et.turn_number > ewt.turn_number
    GROUP BY
        ewt.session_id, ewt.ts, ewt.kind, ewt.tool,
        ewt.message, ewt.severity, ewt.turn_number
)
SELECT
    session_id,
    ts,
    kind,
    tool,
    message,
    severity,
    turn_number,
    resolved_in_turns
FROM resolution
