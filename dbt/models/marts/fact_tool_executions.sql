{{ config(
    materialized='incremental',
    incremental_strategy='delete+insert',
    unique_key=['tenant_id', 'tool_use_id']
) }}
-- Grain: tool_use_id (see schema.yml: not_null + unique on tool_use_id,
-- verified 237110/237110 2026-07-16). One row per tool_use block, LEFT
-- JOINed to its matching tool_result by (tenant_id, tool_use_id).
--
-- INCREMENTAL DESIGN (2026-07-16): was `materialized='table'`, fully
-- rebuilt every dbt cycle by re-joining ALL of stg_tool_calls against ALL of
-- stg_tool_results — the "stalled at ~1.8/2.0 GiB, ~10% CPU" OOM symptom
-- documented in profiles.yml's memory_limit comment. Converted to the same
-- delete+insert incremental pattern as fact_prompts.sql (see that model's
-- header for the full story): raw_events.ts is frozen at first insert and
-- unsafe as a cursor; ingest_checkpoints.last_seen_at is the per-file
-- wall-clock cursor that actually moves on every touch (live append,
-- backfill, or resumed/rewritten session).
{% set lookback_hours = var('fact_tool_executions_lookback_hours', 24) %}

WITH
{% if is_incremental() %}
-- Files touched (grown or re-read) within the lookback window, per tenant.
recent_files AS (
    SELECT tenant_id, file_path
    FROM {{ source('aura', 'ingest_checkpoints') }}
    WHERE last_seen_at >= now() - INTERVAL '{{ lookback_hours }} hours'
),
-- Sessions with at least one recently-touched file. delete+insert on
-- (tenant_id, tool_use_id) then replaces every tool execution of that
-- session.
recent_sessions AS (
    SELECT DISTINCT re.tenant_id, re.session_id
    FROM {{ source('aura', 'raw_events') }} re
    JOIN recent_files rf
        ON  rf.tenant_id = re.tenant_id
        AND rf.file_path = re.file_path
),
{% endif %}
-- Narrowed to recently-touched sessions on an incremental run, same as
-- fact_prompts' joined_fact_turns/joined_fact_tool_executions CTEs — this is
-- what actually bounds the join's build/probe instead of scanning the full
-- upstream history every cycle. On a full-refresh (or first build)
-- is_incremental() is false and both CTEs below are the unfiltered upstream
-- relation, so output is byte-identical to the old `table` model.
tool_calls AS (
    SELECT tc.*
    FROM {{ ref('stg_tool_calls') }} tc
    {% if is_incremental() %}
    JOIN recent_sessions rs
        ON  rs.tenant_id  = tc.tenant_id
        AND rs.session_id = tc.session_id
    {% endif %}
),
tool_results AS (
    SELECT tr.*
    FROM {{ ref('stg_tool_results') }} tr
    {% if is_incremental() %}
    JOIN recent_sessions rs
        ON  rs.tenant_id  = tr.tenant_id
        AND rs.session_id = tr.session_id
    {% endif %}
)
SELECT
    tc.tenant_id,
    tc.session_id,
    tc.event_uuid as assistant_event_uuid,
    tc.tool_use_id,
    tc.ts as tool_call_ts,
    tr.ts as tool_result_ts,
    tc.model,
    tc.tool_name,
    tc.input_payload,
    tr.output_text,
    COALESCE(tr.is_error, FALSE) as is_error,
    date_diff('millisecond', tc.ts, tr.ts) / 1000.0 as execution_duration_seconds
FROM tool_calls tc
LEFT JOIN tool_results tr
    ON tc.tool_use_id = tr.tool_use_id AND tc.tenant_id = tr.tenant_id
