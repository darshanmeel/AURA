{{ config(materialized='view') }}

SELECT
    tenant_id,
    session_id,
    skill_name,
    is_initial
FROM {{ source('raw', 'raw_session_skills') }}
