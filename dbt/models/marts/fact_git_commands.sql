{{ config(materialized='table') }}

SELECT
    tenant_id,
    session_id,
    cwd,
    tool_call_ts                                                                AS ts,
    command                                                                     AS raw_command,
    output_text,
    is_error,
    CASE
        WHEN command LIKE '%git commit%'   THEN 'commit'
        WHEN command LIKE '%git push%'     THEN 'push'
        WHEN command LIKE '%git pull%'     THEN 'pull'
        WHEN command LIKE '%git merge%'    THEN 'merge'
        WHEN command LIKE '%git checkout%' THEN 'checkout'
        WHEN command LIKE '%git branch%'   THEN 'branch'
        WHEN command LIKE '%git log%'      THEN 'log'
        WHEN command LIKE '%git diff%'     THEN 'diff'
        WHEN command LIKE '%git add%'      THEN 'add'
        WHEN command LIKE '%git status%'   THEN 'status'
        ELSE 'other'
    END                                                                         AS git_op
FROM {{ ref('fact_tool_executions') }}
WHERE tool_name = 'Bash'
  AND command LIKE '%git %'
