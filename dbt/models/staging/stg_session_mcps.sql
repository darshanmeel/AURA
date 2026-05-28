{{ config(materialized='view') }}

SELECT
    tenant_id,
    session_id,
    mcp_server,
    first_seen_at
FROM {{ source('raw', 'raw_session_mcps') }}
