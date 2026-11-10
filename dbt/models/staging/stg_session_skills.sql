{{ config(materialized='table') }}

-- First observation wins (at-least-once delivery can repeat a row).
SELECT
    tenant_id,
    session_id,
    skill_name,
    arg_min(is_initial, observed_at) AS is_initial
FROM {{ source('lake', 'raw_session_skills') }}
WHERE {{ lake_cutoff() }}
GROUP BY tenant_id, session_id, skill_name
