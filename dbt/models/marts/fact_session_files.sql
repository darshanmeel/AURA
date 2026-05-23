{{ config(materialized='table') }}

SELECT
    session_id,
    json_extract_string(input_payload, '$.file_path')                                    AS file_path,
    regexp_extract(
        json_extract_string(input_payload, '$.file_path'), '\.([^.]+)$', 1
    )                                                                                    AS file_ext,
    COUNT(*)                                                                             AS edit_count,
    SUM(CASE WHEN tool_name IN ('Edit', 'Write') THEN 1 ELSE 0 END)                     AS write_count
FROM {{ ref('fact_tool_executions') }}
WHERE tool_name IN ('Edit', 'Write', 'Read')
  AND json_extract_string(input_payload, '$.file_path') IS NOT NULL
GROUP BY session_id, file_path
