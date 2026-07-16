{{ config(materialized='table') }}

-- One row per (tenant_id, agent, app_id, project_id).
-- The same agent in two apps = two rows. Keyed by the resolved agent name
-- from dim_sessions (which in turn reads int_event_agent).
--
-- app_id/project_id resolution uses int_app_cwd_lookup, which unnests
-- dim_apps.all_cwds so every cwd variant (trailing-slash, alternate checkout
-- path, etc.) resolves to an app_id rather than silently returning NULL.
-- Previously this joined dim_apps.cwd directly; dim_apps.cwd is an
-- ANY_VALUE (arbitrarily chosen canonical path) so non-canonical cwds
-- would produce NULL app_id/project_id. (D-H2 fix)

WITH app_lookup AS (
    SELECT tenant_id, cwd, app_id, project_id
    FROM {{ ref('int_app_cwd_lookup') }}
),

base AS (
    SELECT
        ds.tenant_id,
        COALESCE(ds.agent, 'main')      AS agent,
        al.app_id,
        al.project_id,
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
    LEFT JOIN app_lookup al
        ON al.cwd       = ds.cwd
       AND al.tenant_id = ds.tenant_id
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
