{{ config(materialized='view') }}

SELECT
    session_id,
    tenant_id,
    person_id,
    person_name,
    commits,
    session_title,
    ingested_at
FROM {{ source('aura', 'session_meta') }}
