{{ config(materialized='table') }}

-- One row per (tenant_id, project_id). Aggregates from dim_apps.
-- project_id is the directory component immediately above apps/services/packages,
-- or the cwd leaf when no monorepo segment is present.

SELECT
    tenant_id,
    project_id,
    project_id                                           AS project_name,
    COUNT(DISTINCT app_id)                               AS app_count,
    SUM(session_count)                                   AS session_count,
    SUM(total_turns)                                     AS total_turns,
    SUM(total_cost)                                      AS total_cost,
    SUM(total_output_tokens)                             AS total_output_tokens,
    array_distinct(flatten(array_agg(all_cwds)))         AS all_cwds,
    MIN(first_seen)                                      AS first_seen,
    MAX(last_seen)                                       AS last_seen
FROM {{ ref('dim_apps') }}
GROUP BY tenant_id, project_id
