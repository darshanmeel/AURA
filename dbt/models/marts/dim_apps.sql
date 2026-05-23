{{ config(materialized='table') }}

SELECT
    tenant_id,
    cwd                                          AS app_id,
    regexp_extract(cwd, '[^/\\]+$')              AS app_name,
    COUNT(DISTINCT session_id)                   AS session_count,
    COUNT(DISTINCT agent)                        AS agent_count,
    array_agg(DISTINCT agent)                    AS agents,
    SUM(total_cost)                              AS total_cost,
    SUM(turn_count)                              AS total_turns,
    MIN(start_ts)                                AS first_seen,
    MAX(end_ts)                                  AS last_seen
FROM {{ ref('dim_sessions') }}
GROUP BY tenant_id, cwd
