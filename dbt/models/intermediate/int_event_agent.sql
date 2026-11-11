{{ config(materialized='table') }}

-- Resolves (tenant_id, event_uuid) -> agent_resolved.
--
-- Non-sidechain events are 'main'. A sidechain event is resolved in this order:
--   1. Agent id: a subagent transcript is written to `.../agent-<id>.jsonl`
--      (file_path), and the Task/Agent tool result that ends the dispatch
--      carries the same id in `toolUseResult.agentId`. That tool result's
--      tool_use_id gives the dispatch's subagent_type. Exact even when several
--      subagents run in parallel.
--   2. Window heuristic, only for sidechain rows with no file agent id (older
--      inline sidechains) or no matching dispatch: the event falls inside the
--      [dispatch_ts, result_ts] window of a Task/Agent call in the same
--      session; on overlap the innermost window wins (latest dispatch_ts, then
--      soonest result_ts). Parallel subagents can be mislabelled here.
--   3. Otherwise 'main'.
-- Grain: one row per (tenant_id, event_uuid); stg_events is already deduped.

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
-- agentId of each dispatch, from the user event holding its tool result.
dispatch_agent_ids AS (
    SELECT
        td.tenant_id,
        e.tool_use_result_agent_id AS agent_id,
        td.subagent_type
    FROM task_dispatches td
    JOIN {{ ref('stg_tool_results') }} tr
        ON tr.tenant_id = td.tenant_id AND tr.tool_use_id = td.tool_use_id
    JOIN {{ ref('stg_events') }} e
        ON e.tenant_id = tr.tenant_id AND e.uuid = tr.event_uuid
    WHERE e.tool_use_result_agent_id IS NOT NULL
    QUALIFY row_number() OVER (PARTITION BY td.tenant_id, agent_id ORDER BY td.subagent_type) = 1
),
sidechain_events AS (
    SELECT
        tenant_id,
        uuid AS event_uuid,
        session_id,
        ts,
        regexp_extract(file_path, 'agent-([0-9a-f]+)\.jsonl$', 1) AS file_agent_id
    FROM {{ ref('stg_events') }}
    WHERE COALESCE(is_sidechain, FALSE)
),
by_agent_id AS (
    SELECT s.tenant_id, s.event_uuid, s.session_id, d.subagent_type AS agent_resolved
    FROM sidechain_events s
    JOIN dispatch_agent_ids d
        ON d.tenant_id = s.tenant_id AND d.agent_id = s.file_agent_id
),
tool_result_first AS (
    SELECT tr.tenant_id, tr.tool_use_id, MIN(tr.ts) AS result_ts
    FROM {{ ref('stg_tool_results') }} tr
    GROUP BY tr.tenant_id, tr.tool_use_id
),
sidechain_windows AS (
    SELECT
        td.tenant_id,
        td.session_id,
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
by_window AS (
    SELECT
        s.tenant_id,
        s.event_uuid,
        s.session_id,
        COALESCE(sw.subagent_type, 'main') AS agent_resolved
    FROM sidechain_events s
    ANTI JOIN by_agent_id b USING (tenant_id, event_uuid)
    LEFT JOIN sidechain_windows sw
        ON  s.tenant_id  = sw.tenant_id
        AND s.session_id = sw.session_id
        AND s.ts >= sw.dispatch_ts
        AND s.ts <= COALESCE(sw.result_ts, s.ts)
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY s.tenant_id, s.event_uuid
        ORDER BY sw.dispatch_ts DESC NULLS LAST, sw.result_ts ASC NULLS LAST
    ) = 1
)
SELECT tenant_id, uuid AS event_uuid, session_id, 'main' AS agent_resolved
FROM {{ ref('stg_events') }}
WHERE NOT COALESCE(is_sidechain, FALSE)
UNION ALL
SELECT tenant_id, event_uuid, session_id, agent_resolved FROM by_agent_id
UNION ALL
SELECT tenant_id, event_uuid, session_id, agent_resolved FROM by_window
