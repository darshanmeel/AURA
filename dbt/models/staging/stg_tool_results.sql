{{ config(
    materialized='incremental',
    incremental_strategy='delete+insert',
    unique_key=['tenant_id', 'event_uuid']
) }}
-- Overrides the staging-level `view` default (dbt_project.yml) for this one
-- model only. This model already embeds a second full stg_tool_calls pass
-- (Case 2 LEFT JOIN); left as a view, every downstream ref() re-runs both the
-- UNION ALL/UNNEST work here AND that nested stg_tool_calls pass. Materializing
-- once as a table is a surgical, single-model change.
--
-- INCREMENTAL DESIGN (2026-07-16): was `materialized='table'` — a full
-- rebuild (full UNNEST over stg_events plus the nested stg_tool_calls LEFT
-- JOIN) on every dbt cycle regardless of how little new data existed, and
-- fact_tool_executions (the only ref() of this model) is itself now
-- incremental (see that model's header), so a full rebuild here would still
-- redo all the work an incremental downstream fact no longer needs.
-- Cursor is ingest_checkpoints.last_seen_at, not raw_events.ts — raw_events.ts
-- is frozen at first insert and unsafe as a cursor (backfill/resume can
-- write old ts values at an arbitrary wall-clock moment); see
-- fact_prompts.sql header for the full story.
-- unique_key is (tenant_id, event_uuid): NOT a strict primary key — verified
-- 2026-07-16 that event_uuid can appear twice in this model's own output
-- (144/238137 rows in production), specifically when a single raw event row
-- satisfies BOTH Case 1 (content-array tool_result block, real tool_use_id)
-- AND Case 2 (top-level toolUseResult with no matching tool call, so
-- tool_use_id lands NULL and the QUALIFY fallback partitions it by its own
-- event_uuid instead) — two distinct partition keys ('<tool_use_id>' vs the
-- literal event_uuid string) can both survive dedup while sharing one
-- event_uuid value. This does not break delete+insert correctness: dbt-duckdb's
-- delete+insert macro (see duckdb__get_delete_insert_merge_sql) issues a plain
-- `DELETE ... USING source WHERE target.key = source.key` semi-join followed
-- by a plain INSERT — it never assumes unique_key is actually unique, so a
-- session with a duplicated event_uuid still gets its old rows fully deleted
-- and the current batch's rows (however many share that key) fully
-- reinserted. tenant_id/event_uuid is kept as the key (matching every other
-- column pair this dedup logic already reasons about) rather than switching
-- to the COALESCE(tool_use_id, event_uuid) dedup expression itself, which
-- would be a needless second change bundled into this one.
{% set lookback_hours = var('stg_tool_results_lookback_hours', 24) %}

WITH
{% if is_incremental() %}
-- Files touched (grown or re-read) within the lookback window, per tenant.
recent_files AS (
    SELECT tenant_id, file_path
    FROM {{ source('aura', 'ingest_checkpoints') }}
    WHERE last_seen_at >= now() - INTERVAL '{{ lookback_hours }} hours'
),
-- Sessions with at least one recently-touched file. delete+insert on
-- (tenant_id, event_uuid) then replaces every tool-result row of that
-- session's events.
recent_sessions AS (
    SELECT DISTINCT re.tenant_id, re.session_id
    FROM {{ source('aura', 'raw_events') }} re
    JOIN recent_files rf
        ON  rf.tenant_id = re.tenant_id
        AND rf.file_path = re.file_path
),
{% endif %}
unioned_results AS (
    -- Case 1: Unnested content array (type = 'tool_result')
    SELECT
        se.tenant_id,
        se.uuid as event_uuid,
        se.session_id,
        se.ts,
        json_extract_string(content_item, '$.tool_use_id') as tool_use_id,
        json_extract_string(content_item, '$.content') as output_text,
        json_extract_string(content_item, '$.is_error') = 'true' as is_error
    FROM {{ ref('stg_events') }} se
    CROSS JOIN UNNEST(CAST(json_extract(se.payload, '$.message.content') AS JSON[])) as t(content_item)
    {% if is_incremental() %}
    JOIN recent_sessions rs
        ON  rs.tenant_id  = se.tenant_id
        AND rs.session_id = se.session_id
    {% endif %}
    WHERE se.event_type = 'user' AND se.payload LIKE '%"type": "tool_result"%'
      AND json_extract_string(content_item, '$.type') = 'tool_result'

    UNION ALL

    -- Case 2: Top-level toolUseResult
    SELECT
        e.tenant_id,
        e.uuid as event_uuid,
        e.session_id,
        e.ts,
        tc.tool_use_id as tool_use_id,
        json_extract_string(e.payload, '$.toolUseResult.text') as output_text,
        COALESCE(json_extract_string(e.payload, '$.toolUseResult.isError') = 'true', FALSE) as is_error
    FROM {{ ref('stg_events') }} e
    LEFT JOIN {{ ref('stg_tool_calls') }} tc
        ON tc.event_uuid = json_extract_string(e.payload, '$.sourceToolAssistantUUID')
    {% if is_incremental() %}
    JOIN recent_sessions rs
        ON  rs.tenant_id  = e.tenant_id
        AND rs.session_id = e.session_id
    {% endif %}
    WHERE e.event_type = 'user' AND json_extract(e.payload, '$.toolUseResult') IS NOT NULL
)
-- Dedup strategy (D-M8 fix):
--
-- When tool_use_id IS NOT NULL: deduplicate across the UNION ALL because
-- Claude's JSONL routinely emits BOTH a tool_result block in the user-message
-- content array (Case 1) AND a top-level toolUseResult field (Case 2) for the
-- same tool_use_id. Partition on (tenant_id, tool_use_id) to collapse those
-- duplicates to one row, preferring the row with non-empty output_text.
--
-- When tool_use_id IS NULL: the Case 2 LEFT JOIN found no matching tool call,
-- so tool_use_id is NULL. Partitioning on (tenant_id, NULL) would collapse
-- ALL null-id rows into one, discarding real results. Instead we fall back to
-- event_uuid (always unique per source row) so each null-id row keeps its own
-- partition and survives with ROW_NUMBER() = 1.
--
-- COALESCE(tool_use_id, event_uuid) achieves both goals in a single QUALIFY:
--   - non-null tool_use_id  -> partition key is tool_use_id  (dedup as before)
--   - null    tool_use_id   -> partition key is event_uuid   (no collapse)
SELECT * FROM unioned_results
QUALIFY ROW_NUMBER() OVER (
    PARTITION BY tenant_id, COALESCE(tool_use_id, event_uuid)
    ORDER BY
        CASE WHEN output_text IS NOT NULL AND LENGTH(output_text) > 0 THEN 0 ELSE 1 END,
        ts
) = 1
