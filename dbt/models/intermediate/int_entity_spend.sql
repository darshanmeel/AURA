{{ config(materialized='table') }}

-- int_entity_spend: daily-grain spend roll-up keyed by entity type + ID.
-- Grain: (tenant_id, entity_type, entity_id, date)
--
-- Supported entity_type values:
--   'app'    — keyed by dim_apps.app_id (resolved via int_app_cwd_lookup)
--   'agent'  — keyed by dim_sessions.agent
--   'person' — keyed by dim_sessions.person_id
--
-- Purpose: replace the repeated inline dim_sessions re-aggregations that all
-- range-filtered API queries perform today. A range query becomes a single
-- filtered GROUP BY on this pre-built table instead of a full dim_sessions scan.
--
-- Note: project_id is carried for 'app' rows so the range path can still filter
-- to a project scope if needed. It is NULL for 'agent' and 'person' rows.

WITH daily_base AS (
    SELECT
        ds.tenant_id,
        CAST(ds.start_ts AS DATE)                AS date,
        ds.session_id,
        ds.agent,
        ds.person_id,
        al.app_id,
        al.project_id,
        ds.turn_count,
        ds.total_cost,
        ds.total_output_tokens,
        ds.tools_used,
        ds.commits
    FROM {{ ref('dim_sessions') }} ds
    LEFT JOIN {{ ref('int_app_cwd_lookup') }} al
        ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id
),

-- ── App grain ──────────────────────────────────────────────────────────────
app_daily AS (
    SELECT
        tenant_id,
        'app'              AS entity_type,
        COALESCE(app_id, 'unknown') AS entity_id,
        project_id,
        date,
        COUNT(DISTINCT session_id) AS session_count,
        SUM(turn_count)            AS total_turns,
        SUM(total_cost)            AS total_cost,
        SUM(total_output_tokens)   AS total_output_tokens,
        SUM(tools_used)            AS total_tool_calls,
        SUM(commits)               AS commits
    FROM daily_base
    WHERE app_id IS NOT NULL
    GROUP BY tenant_id, app_id, project_id, date
),

-- ── Agent grain ────────────────────────────────────────────────────────────
agent_daily AS (
    SELECT
        tenant_id,
        'agent'            AS entity_type,
        COALESCE(agent, 'main') AS entity_id,
        NULL::VARCHAR      AS project_id,
        date,
        COUNT(DISTINCT session_id) AS session_count,
        SUM(turn_count)            AS total_turns,
        SUM(total_cost)            AS total_cost,
        SUM(total_output_tokens)   AS total_output_tokens,
        SUM(tools_used)            AS total_tool_calls,
        SUM(commits)               AS commits
    FROM daily_base
    WHERE agent IS NOT NULL
    GROUP BY tenant_id, agent, date
),

-- ── Person grain ───────────────────────────────────────────────────────────
person_daily AS (
    SELECT
        tenant_id,
        'person'           AS entity_type,
        person_id          AS entity_id,
        NULL::VARCHAR      AS project_id,
        date,
        COUNT(DISTINCT session_id) AS session_count,
        SUM(turn_count)            AS total_turns,
        SUM(total_cost)            AS total_cost,
        SUM(total_output_tokens)   AS total_output_tokens,
        SUM(tools_used)            AS total_tool_calls,
        SUM(commits)               AS commits
    FROM daily_base
    WHERE person_id IS NOT NULL AND person_id != 'unknown'
    GROUP BY tenant_id, person_id, date
)

SELECT * FROM app_daily
UNION ALL
SELECT * FROM agent_daily
UNION ALL
SELECT * FROM person_daily
