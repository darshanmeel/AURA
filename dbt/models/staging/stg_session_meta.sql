{{ config(materialized='table') }}

-- session_meta is append-only observations; collapse to one row per session,
-- taking the latest non-null value of each attribute.
SELECT
    tenant_id,
    session_id,
    arg_max(person_id,       observed_at) FILTER (WHERE person_id       IS NOT NULL) AS person_id,
    arg_max(person_name,     observed_at) FILTER (WHERE person_name     IS NOT NULL) AS person_name,
    arg_max(session_title,   observed_at) FILTER (WHERE session_title   IS NOT NULL) AS session_title,
    arg_max(permission_mode, observed_at) FILTER (WHERE permission_mode IS NOT NULL) AS permission_mode,
    arg_max(mode,            observed_at) FILTER (WHERE mode            IS NOT NULL) AS mode,
    min(observed_at)                                                                 AS ingested_at
FROM {{ source('lake', 'session_meta') }}
WHERE {{ lake_cutoff() }}
GROUP BY tenant_id, session_id
