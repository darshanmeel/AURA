{{ config(
    materialized='incremental',
    incremental_strategy='delete+insert',
    unique_key=['tenant_id', 'prompt_id']
) }}

-- One row per external user prompt. Aggregates everything that happened
-- between prompt_ts and next_prompt_ts (or session end) as a "span".
-- Includes overkill heuristic scoring (complexity_tier vs actual_model_tier)
-- and a set of derived prompt-quality metrics: cache hit rate, time-to-first-
-- token, tool signature, retries, terminal stop reason, distinct models, and
-- sub-agents dispatched.
--
-- INCREMENTAL DESIGN (2026-07-14, OOM fix):
-- This model used to be `materialized='table'` and fully rebuilt every dbt
-- cycle (every 5 min) by scanning ALL of raw_events' history through the
-- fact_tool_executions/fact_turns range-joins below. That full-history scan
-- (with JSON extraction over every tool execution ever recorded) is what
-- exhausted the 4GB DuckDB pool.
--
-- Incremental cursor: the recent_sessions() macro, i.e. sessions with lake
-- rows whose ingested_at (flush time) is newer than this model's last build
-- (_built_at, the cycle's cutoff) minus 1 h. ts is never used as a cursor:
-- backfill writes old ts values at any wall-clock moment. A session
-- recomputed here has ALL of its prompts re-derived, so the previously-last
-- prompt's next_prompt_ts/span aggregates update when a new prompt arrives;
-- delete+insert on (tenant_id, prompt_id) replaces every prompt of it.
-- Run `dbt run --full-refresh -s fact_prompts` to force a full recompute.

WITH
{% if is_incremental() %}
recent_sessions AS ({{ recent_sessions() }}),
{% endif %}
-- Scoped views of the large upstream marts consumed by the range-joins
-- below. On an incremental run these are pre-filtered to recent_sessions
-- so the range-join only builds/probes against recently-touched sessions
-- instead of the full history of fact_turns / fact_tool_executions /
-- stg_assistant_messages. Restricting only the `windowed` driver is NOT
-- enough on its own — these CTEs are what actually bounds the memory of
-- the joins that scan them. On a full-refresh (or the very first build)
-- is_incremental() is false and every one of these is the unfiltered
-- upstream relation, so output is byte-identical to the old `table` model.
joined_fact_turns AS (
    SELECT ft.*
    FROM {{ ref('fact_turns') }} ft
    {% if is_incremental() %}
    JOIN recent_sessions rs
        ON  rs.tenant_id  = ft.tenant_id
        AND rs.session_id = ft.session_id
    {% endif %}
),
joined_fact_tool_executions AS (
    SELECT fte.*
    FROM {{ ref('fact_tool_executions') }} fte
    {% if is_incremental() %}
    JOIN recent_sessions rs
        ON  rs.tenant_id  = fte.tenant_id
        AND rs.session_id = fte.session_id
    {% endif %}
),
joined_stg_assistant_messages AS (
    SELECT am.*
    FROM {{ ref('stg_assistant_messages') }} am
    {% if is_incremental() %}
    JOIN recent_sessions rs
        ON  rs.tenant_id  = am.tenant_id
        AND rs.session_id = am.session_id
    {% endif %}
),
external_user_events AS (
    SELECT
        e.tenant_id,
        e.session_id,
        e.uuid              AS prompt_id,
        e.ts                AS prompt_ts,
        e.parent_uuid,
        e.is_sidechain,
        -- Only string content is a real prompt; array content = tool_result
        CASE
            WHEN substr(trim(e.content_text), 1, 1) = '[' THEN NULL
            ELSE e.content_text
        END                                            AS prompt_text
    FROM {{ ref('stg_events') }} e
    {% if is_incremental() %}
    JOIN recent_sessions rs
        ON  rs.tenant_id  = e.tenant_id
        AND rs.session_id = e.session_id
    {% endif %}
    WHERE e.event_type = 'user'
      AND e.user_type = 'external'
      AND COALESCE(e.is_meta, 'false') != 'true'
      -- Sidechain user events are subagent dispatch payloads, not human prompts;
      -- counting them would split the parent prompt's span (and its cost).
      AND e.is_sidechain = FALSE
),
real_prompts AS (
    SELECT * FROM external_user_events WHERE prompt_text IS NOT NULL
),
windowed AS (
    SELECT
        rp.*,
        LEAD(prompt_ts) OVER (
            PARTITION BY tenant_id, session_id ORDER BY prompt_ts, prompt_id
        )                                              AS next_prompt_ts,
        ROW_NUMBER() OVER (
            PARTITION BY tenant_id, session_id ORDER BY prompt_ts, prompt_id
        )                                              AS prompt_idx
    FROM real_prompts rp
),
-- Span assignment: each turn / tool call / assistant message belongs to the
-- latest prompt at or before its ts (ASOF JOIN). That equals the old
-- `ts >= prompt_ts AND (next_prompt_ts IS NULL OR ts < next_prompt_ts)`
-- window, whose OR blocked DuckDB's range join and made it quadratic per
-- session. Rows before a session's first prompt match no prompt, as before.
-- Prompts sharing a prompt_ts: the last by (prompt_ts, prompt_id) owns the
-- span; the others have an empty [ts, ts) window, as in the old predicate.
span_owners AS (
    SELECT tenant_id, session_id, prompt_id, prompt_ts
    FROM windowed
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY tenant_id, session_id, prompt_ts ORDER BY prompt_id DESC
    ) = 1
),
turn_spans AS (
    SELECT w.prompt_id, ft.*
    FROM joined_fact_turns ft
    ASOF JOIN span_owners w
        ON  w.tenant_id  = ft.tenant_id
        AND w.session_id = ft.session_id
        AND ft.assistant_ts >= w.prompt_ts
),
-- Turn, cache and agent aggregates per span (int_event_agent is unique per
-- (tenant_id, event_uuid), so its join does not fan out).
span_turn_agg AS (
    SELECT
        ts.tenant_id,
        ts.prompt_id,
        COUNT(ts.turn_id)                                            AS turn_count,
        COALESCE(SUM(ts.tool_count), 0)                              AS tool_call_count,
        COALESCE(SUM(ts.output_tokens), 0)                           AS output_tokens_total,
        COALESCE(SUM(ts.calculated_cost), 0)                         AS cost_total,
        FIRST(ts.model ORDER BY ts.assistant_ts)                     AS model_primary,
        -- Last turn in span (its text is fetched in span_last_text)
        LAST(ts.turn_id ORDER BY ts.assistant_ts)                    AS last_turn_id,
        -- TTFT anchor
        MIN(ts.assistant_ts)                                         AS first_assistant_ts,
        array_agg(DISTINCT ts.model)
            FILTER (WHERE ts.model IS NOT NULL)                      AS models_used,
        COALESCE(SUM(ts.cache_read_input_tokens), 0)                 AS cache_read_total,
        COALESCE(SUM(ts.cache_creation_input_tokens), 0)             AS cache_creation_total,
        FIRST(COALESCE(ea.agent_resolved, 'main') ORDER BY ts.assistant_ts) AS agent_resolved
    FROM turn_spans ts
    LEFT JOIN {{ ref('int_event_agent') }} ea
        ON  ea.event_uuid = ts.assistant_event_uuid
        AND ea.tenant_id  = ts.tenant_id
    GROUP BY ts.tenant_id, ts.prompt_id
),
-- Text for the span's last turn: the first text block (positions 0-19) of
-- the turn's winning assistant event.
span_last_text AS (
    SELECT
        sta.prompt_id,
        arg_min(cb.text, cb.block_idx) AS last_assistant_response
    FROM span_turn_agg sta
    JOIN joined_stg_assistant_messages am
        ON  am.tenant_id  = sta.tenant_id
        AND am.message_id = sta.last_turn_id
    JOIN {{ ref('stg_content_blocks') }} cb
        ON  cb.tenant_id  = am.tenant_id
        AND cb.event_uuid = am.uuid
    WHERE cb.block_type = 'text' AND cb.text IS NOT NULL AND cb.block_idx < 20
    GROUP BY sta.prompt_id
),
-- One span assignment of fact_tool_executions feeds every tool aggregate.
span_fte_joined AS (
    SELECT
        w.prompt_id,
        fte.tool_name,
        fte.is_error,
        fte.target_file   AS file_path,
        fte.subagent_type AS subagent_type_val
    FROM joined_fact_tool_executions fte
    ASOF JOIN span_owners w
        ON  w.tenant_id  = fte.tenant_id
        AND w.session_id = fte.session_id
        AND fte.tool_call_ts >= w.prompt_ts
),
-- Tool signature: pipe-joined "ToolName:count" ordered by count desc.
span_tool_counts AS (
    SELECT
        prompt_id,
        tool_name,
        COUNT(*) AS n
    FROM span_fte_joined
    WHERE tool_name IS NOT NULL
    GROUP BY prompt_id, tool_name
),
span_tool_signature AS (
    SELECT
        prompt_id,
        string_agg(tool_name || ':' || n::VARCHAR, '|' ORDER BY n DESC, tool_name)
            AS tool_signature
    FROM span_tool_counts
    GROUP BY prompt_id
),
-- Sub-agents dispatched, distinct files edited, errors caught.
span_fte_scalar_agg AS (
    SELECT
        prompt_id,
        array_agg(DISTINCT subagent_type_val)
            FILTER (WHERE tool_name IN ('Task', 'Agent') AND subagent_type_val IS NOT NULL)
                                                                       AS sub_agents_dispatched,
        COUNT(DISTINCT file_path)
            FILTER (WHERE tool_name IN ('Edit', 'Write') AND file_path IS NOT NULL)
                                                                       AS files_edited,
        COUNT(*) FILTER (WHERE is_error = TRUE)                       AS errors_caught
    FROM span_fte_joined
    GROUP BY prompt_id
),
-- Assistant messages assigned to spans, for retries and the final stop reason.
am_spans AS (
    SELECT
        w.prompt_id,
        am.request_id,
        am.stop_reason,
        am.ts,
        am.byte_offset,
        COUNT(*) OVER (PARTITION BY am.tenant_id, am.session_id, am.request_id) AS request_rows,
        ROW_NUMBER() OVER (PARTITION BY am.tenant_id, am.session_id, am.request_id ORDER BY am.ts) AS request_rn
    FROM joined_stg_assistant_messages am
    ASOF JOIN span_owners w
        ON  w.tenant_id  = am.tenant_id
        AND w.session_id = am.session_id
        AND am.ts >= w.prompt_ts
),
-- Retries: Anthropic retries reuse request_id with a new message_id; each
-- request_id counts once, in the span of its first row, as (rows - 1).
-- Final stop_reason = that of the span's last assistant message.
span_am_agg AS (
    SELECT
        prompt_id,
        COALESCE(SUM(GREATEST(request_rows - 1, 0))
            FILTER (WHERE request_id IS NOT NULL AND request_rn = 1), 0) AS retry_count,
        LAST(stop_reason ORDER BY ts, byte_offset)                       AS final_stop_reason
    FROM am_spans
    GROUP BY prompt_id
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
        -- ~2,000 words; the full prompt stays in the stage (int_turns).
        left(w.prompt_text, 12000)                                          AS prompt_text_full,
        length(w.prompt_text)                                               AS prompt_chars,
        sta.model_primary,
        SUBSTR(slt.last_assistant_response, 1, 200)
            || CASE WHEN length(slt.last_assistant_response) > 200 THEN '…' ELSE '' END
                                                                            AS summary_200,
        COALESCE(sta.turn_count, 0)                                         AS turn_count,
        COALESCE(sta.tool_call_count, 0)                                    AS tool_call_count,
        COALESCE(sta.output_tokens_total, 0)                                AS output_tokens_total,
        COALESCE(sta.cost_total, 0)                                         AS cost_total,
        sta.first_assistant_ts,
        COALESCE(sta.models_used, CAST([] AS VARCHAR[]))                    AS models_used,
        COALESCE(sfa.files_edited, 0)                                       AS files_edited,
        COALESCE(sfa.errors_caught, 0)                                      AS errors_caught,
        -- Cache hit rate: cache_read / (cache_read + cache_write_total).
        -- Denominator is cache_read + cache_creation (the total cache-write bucket,
        -- equal to ephemeral_5m + ephemeral_1h). input_tokens is excluded because
        -- un-cached input does not participate in the cache hit/miss ratio.
        -- NULLIF guards the zero-denominator case; COALESCE to 0.0 keeps the
        -- not_null test green and dashboard arithmetic clean.
        COALESCE(
            CAST(COALESCE(sta.cache_read_total, 0) AS DOUBLE)
            / NULLIF(
                COALESCE(sta.cache_read_total, 0)
                + COALESCE(sta.cache_creation_total, 0),
                0
            ),
            0.0
        )                                                                   AS cache_hit_rate,
        -- TTFT: prompt_ts -> first assistant_ts. NULL if no assistant response
        -- yet (prompt still pending).
        CASE
            WHEN sta.first_assistant_ts IS NULL THEN NULL
            ELSE EXTRACT(EPOCH FROM (sta.first_assistant_ts - w.prompt_ts))
        END                                                                 AS ttft_seconds,
        COALESCE(sts.tool_signature, '')                                    AS tool_signature,
        COALESCE(sam.retry_count, 0)                                        AS retry_count,
        sam.final_stop_reason                                               AS final_stop_reason,
        COALESCE(sfa.sub_agents_dispatched, CAST([] AS VARCHAR[]))          AS sub_agents_dispatched,
        sta.agent_resolved
    FROM windowed w
    LEFT JOIN span_turn_agg      sta ON sta.prompt_id = w.prompt_id
    LEFT JOIN span_last_text     slt ON slt.prompt_id = w.prompt_id
    LEFT JOIN span_fte_scalar_agg sfa ON sfa.prompt_id = w.prompt_id
    LEFT JOIN span_tool_signature sts ON sts.prompt_id = w.prompt_id
    LEFT JOIN span_am_agg        sam ON sam.prompt_id = w.prompt_id
),
-- Attach resolved agent and app/project.
with_agent_and_app AS (
    SELECT
        s.* EXCLUDE (agent_resolved),
        COALESCE(s.agent_resolved, 'main')                                  AS agent,
        ds.app_id,
        ds.project_id,
        EXTRACT(EPOCH FROM (COALESCE(s.next_prompt_ts, NOW()) - s.prompt_ts)) AS duration_seconds
    FROM spans s
    LEFT JOIN {{ ref('dim_sessions') }} ds
        USING (tenant_id, session_id)
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
        -- actual_model_tier: 0=haiku, 1=sonnet/flash, 2=pro, 3=opus;
        -- NULL when the span has no assistant turn (no model to judge).
        CASE
            WHEN model_primary IS NULL                   THEN NULL
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
    complexity_tier             AS expected_model_tier,
    (actual_model_tier > complexity_tier)
                                AS is_overkill,
    CASE
        WHEN actual_model_tier > complexity_tier
        THEN model_primary
             || ' on T' || complexity_tier::VARCHAR
             || ' task: ' || prompt_chars::VARCHAR || ' chars, '
             || tool_call_count::VARCHAR || ' tools, '
             || files_edited::VARCHAR || ' files'
        ELSE NULL
    END                         AS overkill_reason,
    is_sidechain,
    CASE WHEN is_sidechain THEN 'agent' ELSE 'human' END AS prompt_origin,
    {{ built_at() }}            AS _built_at
FROM scored
