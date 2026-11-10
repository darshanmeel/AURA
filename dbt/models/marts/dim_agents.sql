{{ config(materialized='table') }}

-- One row per (tenant_id, agent, app_id, project_id), lifetime.
-- Built per model call: agent = fact_model_calls.agent (resolved per event in
-- int_event_agent) and app = the call's own cwd via int_app_cwd_lookup, the
-- same attribution as int_entity_spend. So SUM(total_cost) equals
-- SUM(fact_model_calls.calculated_cost), and subagent spend is not folded into
-- the session's majority agent. app_id/project_id are NULL for calls without a
-- known cwd.

WITH calls AS (
    SELECT
        fmc.tenant_id,
        fmc.agent,
        al.app_id,
        al.project_id,
        fmc.session_id,
        fmc.ts,
        fmc.calculated_cost,
        fmc.input_tokens,
        fmc.output_tokens
    FROM {{ ref('fact_model_calls') }} fmc
    LEFT JOIN {{ ref('int_app_cwd_lookup') }} al
        ON al.cwd = fmc.cwd AND al.tenant_id = fmc.tenant_id
),
tools AS (
    SELECT
        fte.tenant_id,
        COALESCE(ea.agent_resolved, 'main') AS agent,
        al.app_id,
        al.project_id,
        COUNT(*)                            AS total_tool_calls
    FROM {{ ref('fact_tool_executions') }} fte
    LEFT JOIN {{ ref('int_event_agent') }} ea
        ON ea.tenant_id = fte.tenant_id AND ea.event_uuid = fte.assistant_event_uuid
    LEFT JOIN {{ ref('int_app_cwd_lookup') }} al
        ON al.cwd = fte.cwd AND al.tenant_id = fte.tenant_id
    GROUP BY ALL
),
spend AS (
    SELECT
        tenant_id,
        agent,
        app_id,
        project_id,
        COUNT(DISTINCT session_id)          AS session_count,
        COUNT(*)                            AS total_turns,
        SUM(calculated_cost)                AS total_cost,
        SUM(output_tokens)                  AS total_output_tokens,
        SUM(input_tokens)                   AS total_input_tokens,
        MIN(ts)                             AS first_seen,
        MAX(ts)                             AS last_seen
    FROM calls
    GROUP BY tenant_id, agent, app_id, project_id
)
SELECT
    s.tenant_id,
    s.agent,
    s.app_id,
    s.project_id,
    s.session_count,
    s.total_turns,
    COALESCE(t.total_tool_calls, 0)         AS total_tool_calls,
    s.total_cost,
    s.total_output_tokens,
    s.total_input_tokens,
    s.first_seen,
    s.last_seen
FROM spend s
LEFT JOIN tools t
    ON  t.tenant_id = s.tenant_id
    AND t.agent     = s.agent
    AND t.app_id     IS NOT DISTINCT FROM s.app_id
    AND t.project_id IS NOT DISTINCT FROM s.project_id
