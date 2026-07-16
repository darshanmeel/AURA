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
-- Incremental cursor: raw_events has NO wall-clock ingest column — its
-- schema is tenant_id/uuid/session_id/.../ts/file_path/byte_offset/payload,
-- PK (tenant_id, uuid), written via `INSERT ... ON CONFLICT DO NOTHING`
-- (see watcher/src/aura_watcher/duckdb_writer.py). `ts` is the JSONL event
-- timestamp and is frozen at first insert — it never moves if a uuid is
-- re-ingested (the conflict clause just skips it), and historical backfill
-- can insert very old `ts` values at an arbitrary wall-clock moment. Neither
-- property makes `ts` a safe incremental cursor: a plain "ts >= max(ts) -
-- window" filter would silently and permanently drop backfilled history
-- older than the window.
-- The column that DOES move on every touch (live append OR batched
-- backfill OR a resumed/rewritten session) is
-- ingest_checkpoints.last_seen_at — a per-file wall-clock timestamp set by
-- CheckpointManager.update_checkpoint() every time that file grows or is
-- re-read (watcher/src/aura_watcher/checkpoint.py). Joining
-- raw_events.file_path -> ingest_checkpoints.file_path recovers, per
-- session, "was this session's file touched recently" — the real ingest
-- cursor.
--
-- Trade-off: a session whose file is not touched again within the lookback
-- window below will not be recomputed by an incremental run even if some
-- upstream mart changed for an unrelated reason. A dormant session that
-- resumes/rewrites after months of inactivity IS still caught on the very
-- next incremental run, because the resume touch sets last_seen_at = now()
-- at that moment — always inside the window relative to the run that
-- observes it. The window's real job is to absorb missed/late dbt cycles
-- (watcher paused, backfill lag), not to bridge arbitrarily old resumes.
-- Run `dbt run --full-refresh -s fact_prompts` to force a full recompute.
{% set lookback_hours = var('fact_prompts_lookback_hours', 24) %}

WITH
{% if is_incremental() %}
-- Files touched (grown or re-read) within the lookback window, per tenant.
recent_files AS (
    SELECT tenant_id, file_path
    FROM {{ source('aura', 'ingest_checkpoints') }}
    WHERE last_seen_at >= now() - INTERVAL '{{ lookback_hours }} hours'
),
-- Sessions with at least one recently-touched file. A session recomputed
-- here has ALL of its prompts re-derived (not just new ones), so that the
-- previously-last prompt's next_prompt_ts/span aggregates correctly update
-- when a new prompt is appended after it. delete+insert on
-- (tenant_id, prompt_id) then replaces every prompt of that session.
recent_sessions AS (
    SELECT DISTINCT re.tenant_id, re.session_id
    FROM {{ source('aura', 'raw_events') }} re
    JOIN recent_files rf
        ON  rf.tenant_id = re.tenant_id
        AND rf.file_path = re.file_path
),
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
    {% if is_incremental() %}
    JOIN recent_sessions rs
        ON  rs.tenant_id  = e.tenant_id
        AND rs.session_id = e.session_id
    {% endif %}
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
        w.tenant_id,
        w.prompt_id,
        COUNT(ft.turn_id)                                            AS turn_count,
        COALESCE(SUM(ft.tool_count), 0)                              AS tool_call_count,
        COALESCE(SUM(ft.output_tokens), 0)                           AS output_tokens_total,
        COALESCE(SUM(ft.calculated_cost), 0)                         AS cost_total,
        -- First model in span
        FIRST(ft.model ORDER BY ft.assistant_ts)                     AS model_primary,
        -- Last turn in span (its text is fetched separately from
        -- dim_turn_messages — fact_turns no longer carries assistant_response,
        -- see dim_turn_messages.sql for why)
        LAST(ft.turn_id ORDER BY ft.assistant_ts)                    AS last_turn_id,
        -- First assistant ts in span — TTFT anchor
        MIN(ft.assistant_ts)                                         AS first_assistant_ts,
        -- Distinct models used in span
        array_agg(DISTINCT ft.model)
            FILTER (WHERE ft.model IS NOT NULL)                      AS models_used
    FROM windowed w
    LEFT JOIN joined_fact_turns ft
        ON  ft.tenant_id    = w.tenant_id
        AND ft.session_id   = w.session_id
        AND ft.assistant_ts >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
    GROUP BY w.tenant_id, w.prompt_id
),
-- Text for the span's last turn only (narrow, per-prompt-scoped lookup).
-- dim_turn_messages is a view over int_turns; joining here — instead of on
-- fact_turns directly — is what keeps fact_prompts off the OOM path, since
-- we only ever fetch one turn's text per prompt instead of aggregating text
-- across the whole span.
span_last_text AS (
    SELECT
        sta.prompt_id,
        dtm.assistant_response AS last_assistant_response
    FROM span_turn_agg sta
    JOIN {{ ref('dim_turn_messages') }} dtm
        ON  dtm.tenant_id = sta.tenant_id
        AND dtm.turn_id   = sta.last_turn_id
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
    LEFT JOIN joined_fact_turns ft
        ON  ft.tenant_id    = w.tenant_id
        AND ft.session_id   = w.session_id
        AND ft.assistant_ts >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR ft.assistant_ts < w.next_prompt_ts)
    GROUP BY w.prompt_id
),
-- Single range join against fact_tool_executions for this whole model.
-- Was 4 separate `ts BETWEEN prompt_ts AND next_prompt_ts` range joins
-- (span_tool_counts, span_subagents, span_file_agg, span_error_agg), each
-- re-scanning the full table per session. Collapsed into one pass here;
-- every downstream aggregate below reads from this single materialization
-- instead of re-joining fact_tool_executions.
span_fte_joined AS (
    SELECT
        w.prompt_id,
        fte.tool_name,
        fte.is_error,
        json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path')
            AS file_path,
        json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.subagent_type')
            AS subagent_type_val
    FROM windowed w
    JOIN joined_fact_tool_executions fte
        ON  fte.tenant_id     = w.tenant_id
        AND fte.session_id    = w.session_id
        AND fte.tool_call_ts >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR fte.tool_call_ts < w.next_prompt_ts)
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
-- Scalar per-prompt aggregates that used to be 3 separate range joins
-- (span_subagents, span_file_agg, span_error_agg): sub-agents dispatched,
-- distinct files edited, and errors caught. All computed off the single
-- span_fte_joined pass above via FILTER, one row per prompt_id.
span_fte_scalar_agg AS (
    SELECT
        prompt_id,
        array_agg(DISTINCT subagent_type_val)
            FILTER (WHERE tool_name IN ('TaskCreate', 'Agent') AND subagent_type_val IS NOT NULL)
                                                                       AS sub_agents_dispatched,
        COUNT(DISTINCT file_path)
            FILTER (WHERE tool_name IN ('Edit', 'Write') AND file_path IS NOT NULL)
                                                                       AS files_edited,
        COUNT(*) FILTER (WHERE is_error = TRUE)                       AS errors_caught
    FROM span_fte_joined
    GROUP BY prompt_id
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
        FROM joined_stg_assistant_messages am
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
    LEFT JOIN joined_stg_assistant_messages am
        ON  am.tenant_id  = w.tenant_id
        AND am.session_id = w.session_id
        AND am.ts        >= w.prompt_ts
        AND (w.next_prompt_ts IS NULL OR am.ts < w.next_prompt_ts)
    GROUP BY w.prompt_id
),
-- files_edited and errors_caught now come from span_fte_scalar_agg above
-- (was span_file_agg + span_error_agg, two more range joins against
-- fact_tool_executions). The FILTER-not-JOIN-predicate lesson from the old
-- span_error_agg comment still applies and is preserved: is_error = TRUE
-- lives in a COUNT(*) FILTER, not the join's ON clause, so a prompt with
-- zero tool executions still resolves to 0 (via the outer COALESCE in
-- `spans` below) instead of being miscounted or dropped.
-- Resolved agent: first agent_resolved in span, ordered by assistant_ts.
span_agent_agg AS (
    SELECT
        w.prompt_id,
        FIRST(COALESCE(ea.agent_resolved, 'main') ORDER BY ft.assistant_ts) AS agent_resolved
    FROM windowed w
    LEFT JOIN joined_fact_turns ft
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
        SUBSTR(slt.last_assistant_response, 1, 200)
            || CASE WHEN length(slt.last_assistant_response) > 200 THEN '…' ELSE '' END
                                                                            AS summary_200,
        sta.turn_count,
        sta.tool_call_count,
        sta.output_tokens_total,
        sta.cost_total,
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
            CAST(COALESCE(sca.cache_read_total, 0) AS DOUBLE)
            / NULLIF(
                COALESCE(sca.cache_read_total, 0)
                + COALESCE(sca.cache_creation_total, 0),
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
        COALESCE(sr.retry_count, 0)                                         AS retry_count,
        ss.final_stop_reason                                                AS final_stop_reason,
        COALESCE(sfa.sub_agents_dispatched, CAST([] AS VARCHAR[]))          AS sub_agents_dispatched
    FROM windowed w
    LEFT JOIN span_turn_agg      sta ON sta.prompt_id = w.prompt_id
    LEFT JOIN span_last_text     slt ON slt.prompt_id = w.prompt_id
    LEFT JOIN span_cache_agg     sca ON sca.prompt_id = w.prompt_id
    LEFT JOIN span_fte_scalar_agg sfa ON sfa.prompt_id = w.prompt_id
    LEFT JOIN span_tool_signature sts ON sts.prompt_id = w.prompt_id
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
