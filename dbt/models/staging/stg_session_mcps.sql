{{ config(materialized='table') }}

-- Earliest observation wins (at-least-once delivery can repeat a row).
SELECT
    tenant_id,
    session_id,
    mcp_server,
    min(first_seen_at) AS first_seen_at
FROM {{ source('lake', 'raw_session_mcps') }}
WHERE {{ lake_cutoff() }}
GROUP BY tenant_id, session_id, mcp_server
