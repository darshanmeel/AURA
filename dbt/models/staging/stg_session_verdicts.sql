{{ config(materialized='view') }}

-- One row per (tenant_id, session_id). The watcher enforces uniqueness via
-- ON CONFLICT DO UPDATE, so no dedup ROW_NUMBER is needed here.
SELECT
    session_id,
    tenant_id,
    verdict,
    note,
    created_at
FROM {{ source('aura', 'session_verdicts') }}
