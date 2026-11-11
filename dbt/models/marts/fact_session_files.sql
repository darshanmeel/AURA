{{ config(materialized='table') }}

-- Per-session, per-file rollup of tool activity (Edit, Write, Read).
-- edit_count and write_count count Edit/Write executions only.
-- Proportional attribution of tokens, duration and cost: touches are first
-- collapsed to one row per (session, message_id, file_path), then each file
-- in a turn gets a 1/k share, k = distinct files in that turn (message_id), so
-- per-file sums never exceed the turn totals.

WITH file_touches AS (
    SELECT
        fte.tenant_id,
        fte.session_id,
        fte.message_id,
        fte.target_file AS file_path,
        fte.tool_name,
        fte.execution_duration_seconds
    FROM {{ ref('fact_tool_executions') }} fte
    WHERE fte.tool_name IN ('Edit', 'Write', 'Read')
      AND fte.target_file IS NOT NULL
),
turn_file AS (
    SELECT
        tenant_id,
        session_id,
        message_id,
        file_path,
        SUM(CASE WHEN tool_name IN ('Edit', 'Write') THEN 1 ELSE 0 END) AS edits,
        SUM(execution_duration_seconds)                                 AS duration_seconds
    FROM file_touches
    GROUP BY tenant_id, session_id, message_id, file_path
),
turn_files AS (
    SELECT tenant_id, session_id, message_id, COUNT(*) AS k
    FROM turn_file
    GROUP BY tenant_id, session_id, message_id
),
joined AS (
    SELECT
        tf.tenant_id,
        tf.session_id,
        tf.file_path,
        tf.edits,
        tf.duration_seconds,
        ft.output_tokens,
        ft.calculated_cost,
        k.k
    FROM turn_file tf
    JOIN turn_files k USING (tenant_id, session_id, message_id)
    LEFT JOIN {{ ref('fact_turns') }} ft
        ON ft.tenant_id = tf.tenant_id AND ft.turn_id = tf.message_id
)
SELECT
    tenant_id,
    session_id,
    file_path,
    regexp_extract(file_path, '\.([^.]+)$', 1)                         AS file_ext,
    SUM(edits)                                                         AS edit_count,
    SUM(edits)                                                         AS write_count,
    SUM(duration_seconds / NULLIF(k, 0))                               AS duration_attributed_seconds,
    SUM(COALESCE(output_tokens,   0) / NULLIF(k, 0))                   AS tokens_attributed,
    SUM(COALESCE(calculated_cost, 0) / NULLIF(k, 0))                   AS cost_attributed
FROM joined
GROUP BY tenant_id, session_id, file_path
