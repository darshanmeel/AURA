{{ config(materialized='table') }}

-- Losing copies of raw_events rows that were delivered more than once (crash
-- between flush and checkpoint commit, or a rotation re-read). The newest
-- ingested_at wins; filename/file_row_number break ties. Narrow column read,
-- normally 0 rows. stg_events anti-joins these away.
SELECT tenant_id, uuid, filename, file_row_number
FROM {{ source('lake', 'raw_events') }}
WHERE {{ lake_cutoff() }}
QUALIFY row_number() OVER (
    PARTITION BY tenant_id, uuid
    ORDER BY ingested_at DESC, filename DESC, file_row_number DESC
) > 1
