{{ config(materialized='table') }}

-- Resolves (tenant_id, event_uuid) → agent_resolved.
-- Default is 'main'. When an event falls inside the execution window of a
-- Task/Agent tool dispatch, the dispatching subagent_type is used instead.
--
-- Heuristic: all is_sidechain=true events whose ts falls in
-- [dispatch_ts, result_ts] belong to that Task's subagent.
--
-- Grain note: a session can have overlapping/nested dispatch windows (two
-- Task calls whose [dispatch_ts, result_ts] spans overlap). Without a
-- tie-break, the range join below fans out — one sidechain event can match
-- more than one window, producing more rows than raw_events. The QUALIFY at
-- the bottom picks exactly one window per (tenant_id, event_uuid): the
-- INNERMOST enclosing one (latest dispatch_ts <= event ts, tie-broken by the
-- soonest-ending result_ts) — i.e. the subagent that was actually running
-- when the event was emitted.

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
-- Decorrelated: pre-aggregate the first tool_result timestamp per
-- (tenant_id, tool_use_id) once, then join once. Replaces the previous
-- per-row correlated subquery (SELECT MIN(...) WHERE tool_use_id = td...),
-- which forced a nested-loop re-scan of stg_tool_results per dispatch row.
tool_result_first AS (
    SELECT
        tr.tenant_id,
        tr.tool_use_id,
        MIN(tr.ts) AS result_ts
    FROM {{ ref('stg_tool_results') }} tr
    GROUP BY tr.tenant_id, tr.tool_use_id
),
-- For each dispatch, get the timestamp of the dispatching assistant event
-- and the timestamp of the matching tool_result (= sidechain end).
sidechain_windows AS (
    SELECT
        td.tenant_id,
        td.session_id,
        td.tool_use_id,
        td.subagent_type,
        e.ts           AS dispatch_ts,
        trf.result_ts  AS result_ts
    FROM task_dispatches td
    LEFT JOIN {{ ref('stg_events') }} e
        ON e.uuid       = td.dispatching_event_uuid
       AND e.tenant_id  = td.tenant_id
    LEFT JOIN tool_result_first trf
        ON trf.tenant_id   = td.tenant_id
       AND trf.tool_use_id = td.tool_use_id
),
-- Candidate matches: a sidechain event may fall inside more than one
-- dispatch window here (nested/overlapping Task calls). Non-sidechain
-- events, and sidechain events matching no window, produce exactly one
-- NULL-padded candidate row via the LEFT JOIN.
candidates AS (
    SELECT
        e.tenant_id,
        e.uuid        AS event_uuid,
        e.session_id,
        sw.subagent_type,
        sw.dispatch_ts,
        sw.result_ts
    FROM {{ ref('stg_events') }} e
    LEFT JOIN sidechain_windows sw
        ON  e.tenant_id  = sw.tenant_id
        AND e.session_id = sw.session_id
        AND e.is_sidechain = TRUE
        AND e.ts >= sw.dispatch_ts
        AND e.ts <= COALESCE(sw.result_ts, e.ts)
),
-- Collapse fan-out to exactly one row per (tenant_id, event_uuid): the
-- innermost enclosing window (latest dispatch_ts, i.e. the most recently
-- started — and therefore most specific — subagent dispatch active at
-- event time), tie-broken by the soonest result_ts (tightest span).
labeled AS (
    SELECT
        tenant_id,
        event_uuid,
        session_id,
        COALESCE(subagent_type, 'main') AS agent_resolved
    FROM candidates
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY tenant_id, event_uuid
        ORDER BY dispatch_ts DESC NULLS LAST, result_ts ASC NULLS LAST
    ) = 1
)
SELECT * FROM labeled
