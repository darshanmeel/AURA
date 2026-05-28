{{ config(materialized='table') }}

-- One row per external user prompt. Aggregates everything that happened
-- between prompt_ts and next_prompt_ts (or session end) as a "span".
-- Includes overkill heuristic scoring (complexity_tier vs actual_model_tier)
-- and a set of derived prompt-quality metrics: cache hit rate, time-to-first-
-- token, tool signature, retries, terminal stop reason, distinct models, and
-- sub-agents dispatched.

WITH external_user_events AS (
    SELECT
        e.tenant_id,
        e.session_id,
        e.uuid              AS prompt_id,
        e.ts                AS prompt_ts,
        e.parent_uuid,
        e.is_sidechain,
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
-- Aggregate fact_turns metrics across each prompt's span window.
span_turn_agg AS (
    SELECT
        w.prompt_id,
        COUNT(ft.turn_id)                                            AS turn_count,
        COALESCE(SUM(ft.tool_count), 0)                              AS tool_call_count,
        COALESCE(SUM(ft.output_tokens), 0)                           AS output_tokens_total,
        COALESCE(SUM(ft.calculated_cost), 0)                         AS cost_total,
        -- First model in span
        FIRST(ft.model ORDER BY ft.assistant_ts)                     AS model_primary,
        -- Last assistant response in span (for summary)
        LAST(ft.assistant_response ORDER BY ft.assistant_ts)         AS last_assistant_response,
        -- First assistant ts in span — TTFT anchor
        MIN(ft.assistant_ts)                                         AS first_assistant_ts,
        -- Distinct models used in span
        array_agg(DISTINCT ft.model)
            FILTER (WHERE ft.model IS NOT NULL)                      AS models_used
    FROM windowed w
    LEFT JOIN {{ ref('fact_turns') }} ft
        ON  ft.tenant_id    = w.tenant_id
        AND ft.session_id   = w.session_id
        AND ft.assistant_ts >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
    GROUP BY w.prompt_id
),
-- Cache-token aggregation per span (from raw assistant messages: fact_turns
-- collapses to one row per turn but token columns flow through).
span_cache_agg AS (
    SELECT
        w.prompt_id,
        COALESCE(SUM(ft.cache_read_input_tokens), 0)                 AS cache_read_total,
        COALESCE(SUM(ft.cache_creation_input_tokens), 0)             AS cache_creation_total,
        COALESCE(SUM(ft.input_tokens), 0)                            AS input_tokens_total
    FROM windowed w
    LEFT JOIN {{ ref('fact_turns') }} ft
        ON  ft.tenant_id    = w.tenant_id
        AND ft.session_id   = w.session_id
        AND ft.assistant_ts >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
    GROUP BY w.prompt_id
),
-- Tool signature: pipe-joined "ToolName:count" ordered by count desc.
span_tool_counts AS (
    SELECT
        w.prompt_id,
        fte.tool_name,
        COUNT(*) AS n
    FROM windowed w
    JOIN {{ ref('fact_tool_executions') }} fte
        ON  fte.session_id    = w.session_id
        AND fte.tool_call_ts >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR fte.tool_call_ts < w.next_prompt_ts)
    WHERE fte.tool_name IS NOT NULL
    GROUP BY w.prompt_id, fte.tool_name
),
span_tool_signature AS (
    SELECT
        prompt_id,
        string_agg(tool_name || ':' || n::VARCHAR, '|' ORDER BY n DESC, tool_name)
            AS tool_signature
    FROM span_tool_counts
    GROUP BY prompt_id
),
-- Sub-agents dispatched: TaskCreate / Agent tool calls in the span.
span_subagents AS (
    SELECT
        w.prompt_id,
        array_agg(DISTINCT json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.subagent_type'))
            FILTER (
                WHERE json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.subagent_type') IS NOT NULL
            )                                                        AS sub_agents_dispatched
    FROM windowed w
    LEFT JOIN {{ ref('fact_tool_executions') }} fte
        ON  fte.session_id    = w.session_id
        AND fte.tool_call_ts >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR fte.tool_call_ts < w.next_prompt_ts)
        AND fte.tool_name IN ('TaskCreate', 'Agent')
    GROUP BY w.prompt_id
),
-- Retry detection: count assistant rows per request_id in span; sum (rows - 1).
-- Anthropic retries reuse request_id but emit a new message_id; stg_assistant_messages
-- dedups by message_id, so a request_id with >1 rows here = retry(s).
span_retries AS (
    SELECT
        w.prompt_id,
        COALESCE(SUM(GREATEST(rc.n - 1, 0)), 0) AS retry_count
    FROM windowed w
    LEFT JOIN (
        SELECT
            am.tenant_id,
            am.session_id,
            am.request_id,
            am.ts,
            COUNT(*) OVER (PARTITION BY am.tenant_id, am.session_id, am.request_id) AS n,
            ROW_NUMBER() OVER (PARTITION BY am.tenant_id, am.session_id, am.request_id ORDER BY am.ts) AS rn
        FROM {{ ref('stg_assistant_messages') }} am
        WHERE am.request_id IS NOT NULL
    ) rc
        ON  rc.tenant_id  = w.tenant_id
        AND rc.session_id = w.session_id
        AND rc.ts        >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR rc.ts < w.next_prompt_ts)
        AND rc.rn = 1   -- count each request_id once per span
    GROUP BY w.prompt_id
),
-- Final stop_reason for the span = stop_reason of the last assistant message
-- (by ts) in the window.
span_stop AS (
    SELECT
        w.prompt_id,
        LAST(am.stop_reason ORDER BY am.ts, am.byte_offset) AS final_stop_reason
    FROM windowed w
    LEFT JOIN {{ ref('stg_assistant_messages') }} am
        ON  am.tenant_id  = w.tenant_id
        AND am.session_id = w.session_id
        AND am.ts        >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR am.ts < w.next_prompt_ts)
    GROUP BY w.prompt_id
),
-- Count distinct files edited in each span.
span_file_agg AS (
    SELECT
        w.prompt_id,
        COUNT(DISTINCT json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path')) AS files_edited
    FROM windowed w
    LEFT JOIN {{ ref('fact_tool_executions') }} fte
        ON  fte.session_id    = w.session_id
        AND fte.tool_call_ts >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR fte.tool_call_ts < w.next_prompt_ts)
        AND fte.tool_name IN ('Edit', 'Write')
        AND json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path') IS NOT NULL
    GROUP BY w.prompt_id
),
-- Count errors in each span.
-- Predicate moved out of the LEFT JOIN's ON clause into a COUNT(*) FILTER:
-- with is_error=TRUE in the JOIN, prompts with zero errors still produced
-- one null-padded row and COUNT(*) counted it as 1, so every prompt was
-- mis-classified as having ≥1 error. FILTER correctly skips null-padded
-- rows (is_error IS NULL on no-match), and keeping the LEFT JOIN ensures
-- every prompt still gets a 0 row instead of vanishing.
span_error_agg AS (
    SELECT
        w.prompt_id,
        COUNT(*) FILTER (WHERE fte.is_error = TRUE) AS errors_caught
    FROM windowed w
    LEFT JOIN {{ ref('fact_tool_executions') }} fte
        ON  fte.session_id    = w.session_id
        AND fte.tool_call_ts >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR fte.tool_call_ts < w.next_prompt_ts)
    GROUP BY w.prompt_id
),
-- Resolved agent: first agent_resolved in span, ordered by assistant_ts.
span_agent_agg AS (
    SELECT
        w.prompt_id,
        FIRST(COALESCE(ea.agent_resolved, 'main') ORDER BY ft.assistant_ts) AS agent_resolved
    FROM windowed w
    LEFT JOIN {{ ref('fact_turns') }} ft
        ON  ft.tenant_id    = w.tenant_id
        AND ft.session_id   = w.session_id
        AND ft.assistant_ts >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
    LEFT JOIN {{ ref('int_event_agent') }} ea
        ON ea.event_uuid = ft.assistant_event_uuid
       AND ea.tenant_id  = ft.tenant_id
    GROUP BY w.prompt_id
),
-- Assemble all span aggregates back onto windowed prompts.
spans AS (
    SELECT
        w.tenant_id,
        w.session_id,
        w.prompt_id,
        w.prompt_ts,
        w.next_prompt_ts,
        w.prompt_idx,
        w.is_sidechain,
        SUBSTR(w.prompt_text, 1, 200)
            || CASE WHEN length(w.prompt_text) > 200 THEN '…' ELSE '' END   AS prompt_text_200,
        w.prompt_text                                                       AS prompt_text_full,
        length(w.prompt_text)                                               AS prompt_chars,
        sta.model_primary,
        SUBSTR(sta.last_assistant_response, 1, 200)
            || CASE WHEN length(sta.last_assistant_response) > 200 THEN '…' ELSE '' END
                                                                            AS summary_200,
        sta.turn_count,
        sta.tool_call_count,
        sta.output_tokens_total,
        sta.cost_total,
        sta.first_assistant_ts,
        COALESCE(sta.models_used, CAST([] AS VARCHAR[]))                    AS models_used,
        COALESCE(sfa.files_edited, 0)                                       AS files_edited,
        COALESCE(sea.errors_caught, 0)                                      AS errors_caught,
        -- Cache hit rate: cache_read / (cache_read + cache_creation + input).
        -- Returns 0 (not NULL) for empty windows so downstream not_null test
        -- and dashboard math both stay clean.
        CASE
            WHEN COALESCE(sca.cache_read_total, 0)
               + COALESCE(sca.cache_creation_total, 0)
               + COALESCE(sca.input_tokens_total, 0) = 0
            THEN 0.0
            ELSE CAST(COALESCE(sca.cache_read_total, 0) AS DOUBLE)
                 / (COALESCE(sca.cache_read_total, 0)
                    + COALESCE(sca.cache_creation_total, 0)
                    + COALESCE(sca.input_tokens_total, 0))
        END                                                                 AS cache_hit_rate,
        -- TTFT: prompt_ts -> first assistant_ts. NULL if no assistant response
        -- yet (prompt still pending).
        CASE
            WHEN sta.first_assistant_ts IS NULL THEN NULL
            ELSE EXTRACT(EPOCH FROM (sta.first_assistant_ts - w.prompt_ts))
        END                                                                 AS ttft_seconds,
        COALESCE(sts.tool_signature, '')                                    AS tool_signature,
        COALESCE(sr.retry_count, 0)                                         AS retry_count,
        ss.final_stop_reason                                                AS final_stop_reason,
        COALESCE(ssa.sub_agents_dispatched, CAST([] AS VARCHAR[]))          AS sub_agents_dispatched
    FROM windowed w
    LEFT JOIN span_turn_agg      sta ON sta.prompt_id = w.prompt_id
    LEFT JOIN span_cache_agg     sca ON sca.prompt_id = w.prompt_id
    LEFT JOIN span_file_agg      sfa ON sfa.prompt_id = w.prompt_id
    LEFT JOIN span_error_agg     sea ON sea.prompt_id = w.prompt_id
    LEFT JOIN span_tool_signature sts ON sts.prompt_id = w.prompt_id
    LEFT JOIN span_subagents     ssa ON ssa.prompt_id = w.prompt_id
    LEFT JOIN span_retries       sr  ON sr.prompt_id  = w.prompt_id
    LEFT JOIN span_stop          ss  ON ss.prompt_id  = w.prompt_id
),
-- Attach resolved agent (from span_agent_agg) and app/project.
with_agent_and_app AS (
    SELECT
        s.*,
        COALESCE(saa.agent_resolved, 'main')                                AS agent,
        da.app_id,
        da.project_id,
        EXTRACT(EPOCH FROM (COALESCE(s.next_prompt_ts, NOW()) - s.prompt_ts)) AS duration_seconds
    FROM spans s
    LEFT JOIN span_agent_agg saa ON saa.prompt_id = s.prompt_id
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
    -- New derived metrics
    cache_hit_rate,
    ttft_seconds,
    tool_signature,
    retry_count,
    final_stop_reason,
    models_used,
    sub_agents_dispatched,
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
    END                         AS overkill_reason,
    is_sidechain,
    CASE WHEN is_sidechain THEN 'agent' ELSE 'human' END AS prompt_origin
FROM scored
