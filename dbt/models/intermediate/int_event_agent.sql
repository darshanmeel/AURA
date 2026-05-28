{{ config(materialized='table') }}

-- Resolves (tenant_id, event_uuid) → agent_resolved.
-- Default is 'main'. When an event falls inside the execution window of a
-- Task/Agent tool dispatch, the dispatching subagent_type is used instead.
--
-- Heuristic: all is_sidechain=true events whose ts falls in
-- [dispatch_ts, result_ts] belong to that Task's subagent.

WITH task_dispatches AS (
    SELECT
        tc.tenant_id,
        tc.session_id,
        tc.tool_use_id,
        tc.event_uuid     AS dispatching_event_uuid,
        json_extract_string(CAST(tc.input_payload AS VARCHAR), '$.subagent_type') AS subagent_type
    FROM {{ ref('stg_tool_calls') }} tc
    WHERE tc.tool_name IN ('Task', 'Agent')
      AND json_extract_string(CAST(tc.input_payload AS VARCHAR), '$.subagent_type') IS NOT NULL
),
-- For each dispatch, get the timestamp of the dispatching assistant event
-- and the timestamp of the matching tool_result (= sidechain end).
sidechain_windows AS (
    SELECT
        td.tenant_id,
        td.session_id,
        td.tool_use_id,
        td.subagent_type,
        e.ts                                                                     AS dispatch_ts,
        (
            SELECT MIN(tr.ts)
            FROM {{ ref('stg_tool_results') }} tr
            WHERE tr.tool_use_id = td.tool_use_id
              AND tr.tenant_id   = td.tenant_id
        )                                                                        AS result_ts
    FROM task_dispatches td
    LEFT JOIN {{ ref('stg_events') }} e
        ON e.uuid       = td.dispatching_event_uuid
       AND e.tenant_id  = td.tenant_id
),
-- Stamp every is_sidechain event that falls inside a dispatch window.
-- Non-sidechain events (and sidechain events with no matching window) → 'main'.
labeled AS (
    SELECT
        e.tenant_id,
        e.uuid        AS event_uuid,
        e.session_id,
        COALESCE(sw.subagent_type, 'main') AS agent_resolved
    FROM {{ ref('stg_events') }} e
    LEFT JOIN sidechain_windows sw
        ON  e.tenant_id  = sw.tenant_id
        AND e.session_id = sw.session_id
        AND e.is_sidechain = TRUE
        AND e.ts >= sw.dispatch_ts
        AND e.ts <= COALESCE(sw.result_ts, e.ts)
)
SELECT * FROM labeled
