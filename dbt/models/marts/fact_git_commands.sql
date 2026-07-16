{{ config(materialized='table') }}

SELECT
    tenant_id,
    session_id,
    tool_call_ts                                                                AS ts,
    json_extract_string(input_payload, '$.command')                             AS raw_command,
    output_text,
    is_error,
    CASE
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git commit%'   THEN 'commit'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git push%'     THEN 'push'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git pull%'     THEN 'pull'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git merge%'    THEN 'merge'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git checkout%' THEN 'checkout'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git branch%'   THEN 'branch'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git log%'      THEN 'log'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git diff%'     THEN 'diff'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git add%'      THEN 'add'
        WHEN json_extract_string(input_payload, '$.command') LIKE '%git status%'   THEN 'status'
        ELSE 'other'
    END                                                                         AS git_op
FROM {{ ref('fact_tool_executions') }}
WHERE tool_name = 'Bash'
  AND json_extract_string(input_payload, '$.command') LIKE '%git %'
