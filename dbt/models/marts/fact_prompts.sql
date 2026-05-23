{{ config(materialized='table') }}

-- One row per external user prompt. Aggregates everything that happened
-- between prompt_ts and next_prompt_ts (or session end) as a "span".
-- Includes overkill heuristic scoring (complexity_tier vs actual_model_tier).

WITH external_user_events AS (
    SELECT
        e.tenant_id,
        e.session_id,
        e.uuid              AS prompt_id,
        e.ts                AS prompt_ts,
        e.parent_uuid,
        e.payload,
        json_extract_string(e.payload, '$.userType')   AS user_type,
        json_extract_string(e.payload, '$.isMeta')     AS is_meta,
        -- Only string content is a real prompt; array content = tool_result
        CASE
            WHEN substr(trim(json_extract_string(e.payload, '$.message.content')), 1, 1) = '['
            THEN NULL
            ELSE json_extract_string(e.payload, '$.message.content')
        END                                            AS prompt_text
    FROM {{ ref('stg_events') }} e
    WHERE e.event_type = 'user'
      AND json_extract_string(e.payload, '$.userType') = 'external'
      AND COALESCE(json_extract_string(e.payload, '$.isMeta'), 'false') != 'true'
),
real_prompts AS (
    SELECT * FROM external_user_events WHERE prompt_text IS NOT NULL
),
windowed AS (
    SELECT
        rp.*,
        LEAD(prompt_ts) OVER (
            PARTITION BY tenant_id, session_id ORDER BY prompt_ts
        )                                              AS next_prompt_ts,
        ROW_NUMBER() OVER (
            PARTITION BY tenant_id, session_id ORDER BY prompt_ts
        )                                              AS prompt_idx
    FROM real_prompts rp
),
-- Aggregate everything that happened between prompt_ts and next_prompt_ts.
spans AS (
    SELECT
        w.tenant_id,
        w.session_id,
        w.prompt_id,
        w.prompt_ts,
        w.next_prompt_ts,
        w.prompt_idx,
        SUBSTR(w.prompt_text, 1, 200)
            || CASE WHEN length(w.prompt_text) > 200 THEN '…' ELSE '' END   AS prompt_text_200,
        w.prompt_text                                                       AS prompt_text_full,
        length(w.prompt_text)                                               AS prompt_chars,
        -- model from first assistant turn in span
        (
            SELECT ft.model
            FROM {{ ref('fact_turns') }} ft
            WHERE ft.session_id  = w.session_id
              AND ft.tenant_id   = w.tenant_id
              AND ft.assistant_ts >= w.prompt_ts
              AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
            ORDER BY ft.assistant_ts
            LIMIT 1
        )                                                                   AS model_primary,
        -- 200-char summary from LAST assistant response in span
        (
            SELECT
                SUBSTR(ft.assistant_response, 1, 200)
                || CASE WHEN length(ft.assistant_response) > 200 THEN '…' ELSE '' END
            FROM {{ ref('fact_turns') }} ft
            WHERE ft.session_id  = w.session_id
              AND ft.tenant_id   = w.tenant_id
              AND ft.assistant_ts >= w.prompt_ts
              AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
              AND ft.assistant_response IS NOT NULL
            ORDER BY ft.assistant_ts DESC
            LIMIT 1
        )                                                                   AS summary_200,
        -- turn count in span
        (
            SELECT COUNT(*)
            FROM {{ ref('fact_turns') }} ft
            WHERE ft.session_id  = w.session_id
              AND ft.tenant_id   = w.tenant_id
              AND ft.assistant_ts >= w.prompt_ts
              AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
        )                                                                   AS turn_count,
        -- tool call count in span
        (
            SELECT COALESCE(SUM(ft.tool_count), 0)
            FROM {{ ref('fact_turns') }} ft
            WHERE ft.session_id  = w.session_id
              AND ft.tenant_id   = w.tenant_id
              AND ft.assistant_ts >= w.prompt_ts
              AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
        )                                                                   AS tool_call_count,
        -- output tokens in span
        (
            SELECT COALESCE(SUM(ft.output_tokens), 0)
            FROM {{ ref('fact_turns') }} ft
            WHERE ft.session_id  = w.session_id
              AND ft.tenant_id   = w.tenant_id
              AND ft.assistant_ts >= w.prompt_ts
              AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
        )                                                                   AS output_tokens_total,
        -- cost in span
        (
            SELECT COALESCE(SUM(ft.calculated_cost), 0)
            FROM {{ ref('fact_turns') }} ft
            WHERE ft.session_id  = w.session_id
              AND ft.tenant_id   = w.tenant_id
              AND ft.assistant_ts >= w.prompt_ts
              AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
        )                                                                   AS cost_total,
        -- distinct files edited in span
        (
            SELECT COUNT(DISTINCT json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path'))
            FROM {{ ref('fact_tool_executions') }} fte
            WHERE fte.session_id    = w.session_id
              AND fte.tool_call_ts >= w.prompt_ts
              AND (w.next_prompt_ts IS NULL OR fte.tool_call_ts < w.next_prompt_ts)
              AND fte.tool_name IN ('Edit', 'Write')
              AND json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path') IS NOT NULL
        )                                                                   AS files_edited,
        -- errors in span
        (
            SELECT COUNT(*)
            FROM {{ ref('fact_tool_executions') }} fte
            WHERE fte.session_id    = w.session_id
              AND fte.tool_call_ts >= w.prompt_ts
              AND (w.next_prompt_ts IS NULL OR fte.tool_call_ts < w.next_prompt_ts)
              AND fte.is_error = TRUE
        )                                                                   AS errors_caught
    FROM windowed w
),
-- Attach resolved agent (from first assistant turn's event) and app/project.
with_agent_and_app AS (
    SELECT
        s.*,
        -- resolved agent on the first assistant turn in span
        (
            SELECT COALESCE(ea.agent_resolved, 'main')
            FROM {{ ref('fact_turns') }} ft
            JOIN {{ ref('int_event_agent') }} ea
                ON ea.event_uuid = ft.assistant_event_uuid
               AND ea.tenant_id  = ft.tenant_id
            WHERE ft.session_id  = s.session_id
              AND ft.tenant_id   = s.tenant_id
              AND ft.assistant_ts >= s.prompt_ts
              AND (s.next_prompt_ts IS NULL OR ft.assistant_ts < s.next_prompt_ts)
            ORDER BY ft.assistant_ts
            LIMIT 1
        )                                                                   AS agent,
        da.app_id,
        da.project_id,
        EXTRACT(EPOCH FROM (COALESCE(s.next_prompt_ts, NOW()) - s.prompt_ts)) AS duration_seconds
    FROM spans s
    LEFT JOIN {{ ref('dim_sessions') }} ds
        USING (tenant_id, session_id)
    LEFT JOIN {{ ref('dim_apps') }} da
        ON da.cwd = ds.cwd
       AND da.tenant_id = s.tenant_id
),
-- Overkill heuristic scoring.
scored AS (
    SELECT
        *,
        -- complexity_tier = max of three signal buckets (0=S, 1=M, 2=L, 3=XL)
        GREATEST(
            CASE
                WHEN COALESCE(prompt_chars, 0) < 400  THEN 0
                WHEN prompt_chars < 1600              THEN 1
                WHEN prompt_chars < 6000              THEN 2
                ELSE 3
            END,
            CASE
                WHEN tool_call_count = 0              THEN 0
                WHEN tool_call_count < 5              THEN 1
                WHEN tool_call_count < 20             THEN 2
                ELSE 3
            END,
            CASE
                WHEN files_edited = 0                 THEN 0
                WHEN files_edited < 3                 THEN 1
                WHEN files_edited < 8                 THEN 2
                ELSE 3
            END
        )                                                                    AS complexity_tier,
        -- actual_model_tier: 0=haiku, 1=sonnet/flash, 2=pro, 3=opus
        CASE
            WHEN model_primary LIKE '%haiku%'            THEN 0
            WHEN model_primary LIKE '%gemini-2.5-flash%' THEN 1
            WHEN model_primary LIKE '%sonnet%'           THEN 1
            WHEN model_primary LIKE '%gemini-2.5-pro%'   THEN 2
            WHEN model_primary LIKE '%opus%'             THEN 3
            ELSE 1
        END                                                                  AS actual_model_tier
    FROM with_agent_and_app
)
SELECT
    tenant_id,
    session_id,
    prompt_id,
    prompt_idx,
    prompt_ts,
    next_prompt_ts,
    duration_seconds,
    prompt_text_200,
    prompt_text_full,
    prompt_chars,
    summary_200,
    COALESCE(agent, 'main')     AS agent,
    app_id,
    project_id,
    model_primary,
    turn_count,
    tool_call_count,
    files_edited,
    output_tokens_total,
    cost_total,
    errors_caught,
    complexity_tier,
    actual_model_tier,
    CASE complexity_tier
        WHEN 0 THEN 0
        WHEN 1 THEN 1
        WHEN 2 THEN 2
        ELSE 3
    END                         AS expected_model_tier,
    (actual_model_tier > CASE complexity_tier WHEN 0 THEN 0 WHEN 1 THEN 1 WHEN 2 THEN 2 ELSE 3 END)
                                AS is_overkill,
    CASE
        WHEN actual_model_tier > CASE complexity_tier WHEN 0 THEN 0 WHEN 1 THEN 1 WHEN 2 THEN 2 ELSE 3 END
        THEN model_primary
             || ' on T' || complexity_tier::VARCHAR
             || ' task: ' || prompt_chars::VARCHAR || ' chars, '
             || tool_call_count::VARCHAR || ' tools, '
             || files_edited::VARCHAR || ' files'
        ELSE NULL
    END                         AS overkill_reason
FROM scored
