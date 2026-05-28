{{ config(materialized='table') }}

SELECT
    tenant_id,
    person_id,
    ANY_VALUE(person_name)       AS person_name,
    COUNT(DISTINCT session_id)   AS session_count,
    COUNT(DISTINCT cwd)          AS app_count,
    array_agg(DISTINCT agent)    AS agents,
    array_agg(DISTINCT cwd)      AS apps,
    SUM(total_cost)              AS total_cost,
    SUM(turn_count)              AS total_turns,
    SUM(total_input_tokens)      AS total_input_tokens,
    SUM(total_output_tokens)     AS total_output_tokens,
    SUM(commits)                 AS total_commits
FROM {{ ref('dim_sessions') }}
WHERE person_id IS NOT NULL
GROUP BY tenant_id, person_id
