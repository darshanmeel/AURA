{{ config(materialized='table') }}

-- Per-session, per-file rollup of tool activity.
-- Keeps original edit_count and write_count columns.
-- Adds proportional attribution of tokens, duration, and cost:
--   each file in a turn gets 1/k share where k = distinct files in that turn.

WITH file_touches AS (
    SELECT
        fte.tenant_id,
        fte.session_id,
        fte.assistant_event_uuid,
        json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path') AS file_path,
        regexp_extract(
            json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path'),
            '\.([^.]+)$', 1
        )                                                                      AS file_ext,
        fte.tool_name,
        fte.execution_duration_seconds
    FROM {{ ref('fact_tool_executions') }} fte
    WHERE fte.tool_name IN ('Edit', 'Write', 'Read')
      AND json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path') IS NOT NULL
),
-- Count distinct files per assistant turn (k) for proportional attribution.
turn_files AS (
    SELECT
        tenant_id,
        session_id,
        assistant_event_uuid,
        COUNT(DISTINCT file_path) AS k
    FROM file_touches
    GROUP BY tenant_id, session_id, assistant_event_uuid
),
-- Token and cost metrics from fact_turns (already joined to model_calls).
turn_metrics AS (
    SELECT
        ft.tenant_id,
        ft.session_id,
        ft.assistant_event_uuid,
        ft.output_tokens,
        ft.calculated_cost
    FROM {{ ref('fact_turns') }} ft
),
joined AS (
    SELECT
        ft.tenant_id,
        ft.session_id,
        ft.file_path,
        ft.file_ext,
        ft.tool_name,
        ft.execution_duration_seconds,
        tm.output_tokens,
        tm.calculated_cost,
        tf.k
    FROM file_touches ft
    LEFT JOIN turn_files   tf USING (tenant_id, session_id, assistant_event_uuid)
    LEFT JOIN turn_metrics tm USING (tenant_id, session_id, assistant_event_uuid)
)
SELECT
    tenant_id,
    session_id,
    file_path,
    file_ext,
    COUNT(*)                                                                AS edit_count,
    SUM(CASE WHEN tool_name IN ('Edit', 'Write') THEN 1 ELSE 0 END)        AS write_count,
    -- Proportional attribution: each file gets 1/k of the turn's metrics.
    SUM(execution_duration_seconds)                                        AS duration_attributed_seconds,
    SUM(COALESCE(output_tokens,    0) / NULLIF(k, 0))                     AS tokens_attributed,
    SUM(COALESCE(calculated_cost,  0) / NULLIF(k, 0))                     AS cost_attributed
FROM joined
GROUP BY tenant_id, session_id, file_path, file_ext
