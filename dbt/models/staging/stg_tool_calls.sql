{{ config(materialized='table') }}
-- Overrides the staging-level `view` default (dbt_project.yml) for this one
-- model only. Rationale: heavy JSON UNNEST over stg_events is re-executed on
-- every downstream ref() when left as a view; fact_tool_executions references
-- it twice and int_event_agent once, so a view recomputes the UNNEST 3x per
-- dbt run. Materializing once as a table is a surgical, single-model change
-- (no other staging model's materialization changes).

WITH exploded AS (
    SELECT
        tenant_id,
        uuid as event_uuid,
        session_id,
        ts,
        model,
        UNNEST(CAST(json_extract(payload, '$.message.content') AS JSON[])) as content_item
    FROM {{ ref('stg_events') }}
    WHERE event_type = 'assistant' AND payload LIKE '%"type": "tool_use"%'
)
SELECT
    tenant_id,
    event_uuid,
    session_id,
    ts,
    model,
    json_extract_string(content_item, '$.id') as tool_use_id,
    json_extract_string(content_item, '$.name') as tool_name,
    json_extract(content_item, '$.input') as input_payload
FROM exploded
WHERE json_extract_string(content_item, '$.type') = 'tool_use'
