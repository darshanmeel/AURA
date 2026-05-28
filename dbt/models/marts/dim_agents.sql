{{ config(materialized='table') }}

-- One row per (tenant_id, agent, app_id, project_id).
-- The same agent in two apps = two rows. Keyed by the resolved agent name
-- from dim_sessions (which in turn reads int_event_agent).

WITH base AS (
    SELECT
        ds.tenant_id,
        COALESCE(ds.agent, 'main')      AS agent,
        da.app_id,
        da.project_id,
        ds.session_id,
        ds.turn_count,
        ds.total_cost,
        ds.tools_used,
        ds.files_touched,
        ds.total_output_tokens,
        ds.total_input_tokens,
        ds.start_ts,
        ds.end_ts
    FROM {{ ref('dim_sessions') }} ds
    LEFT JOIN {{ ref('dim_apps') }} da
        ON da.cwd        = ds.cwd
       AND da.tenant_id  = ds.tenant_id
)
SELECT
    tenant_id,
    agent,
    app_id,
    project_id,
    COUNT(DISTINCT session_id)                  AS session_count,
    SUM(turn_count)                             AS total_turns,
    SUM(tools_used)                             AS total_tool_calls,
    SUM(total_cost)                             AS total_cost,
    SUM(total_output_tokens)                    AS total_output_tokens,
    SUM(total_input_tokens)                     AS total_input_tokens,
    SUM(files_touched)                          AS total_files,
    MIN(start_ts)                               AS first_seen,
    MAX(COALESCE(end_ts, start_ts))             AS last_seen
FROM base
GROUP BY tenant_id, agent, app_id, project_id
