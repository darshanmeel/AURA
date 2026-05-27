{{ config(materialized='table') }}

-- int_entity_spend: daily-grain spend roll-up keyed by entity type + ID.
-- Grain: (tenant_id, entity_type, entity_id, date)
--
-- IMPORTANT: cost is sourced from fact_model_calls.ts (event timestamp),
-- NOT from dim_sessions.start_ts. This ensures cost for a given date matches
-- fact_daily_spend and fact_spend_pace for the same period.
--
-- Supported entity_type values:
--   'app'    — keyed by dim_apps.app_id (resolved via int_app_cwd_lookup)
--   'agent'  — keyed by fact_model_calls.agent
--   'person' — keyed by dim_sessions.person_id

WITH fmc_base AS (
    SELECT
        fmc.tenant_id,
        CAST(fmc.ts AS DATE)                AS date,
        fmc.session_id,
        fmc.agent,
        fmc.calculated_cost,
        fmc.output_tokens,
        ds.person_id,
        al.app_id,
        al.project_id
    FROM {{ ref('fact_model_calls') }} fmc
    LEFT JOIN {{ ref('dim_sessions') }} ds
        ON ds.session_id = fmc.session_id AND ds.tenant_id = fmc.tenant_id
    LEFT JOIN {{ ref('int_app_cwd_lookup') }} al
        ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id
),

-- Turn counts by event date (assistant_ts), not session start date
turns_by_date AS (
    SELECT
        tenant_id,
        session_id,
        CAST(assistant_ts AS DATE) AS date,
        COUNT(*) AS turn_count
    FROM {{ ref('fact_turns') }}
    GROUP BY tenant_id, session_id, CAST(assistant_ts AS DATE)
),

-- Session-level metadata joined once (commits, tools_used are session totals)
session_meta AS (
    SELECT session_id, tenant_id, commits, tools_used
    FROM {{ ref('dim_sessions') }}
),

-- ── App grain ──────────────────────────────────────────────────────────────
app_daily AS (
    SELECT
        b.tenant_id,
        'app'                          AS entity_type,
        b.app_id                       AS entity_id,
        b.project_id,
        b.date,
        COUNT(DISTINCT b.session_id)   AS session_count,
        COALESCE(SUM(t.turn_count), 0) AS total_turns,
        SUM(b.calculated_cost)         AS total_cost,
        SUM(b.output_tokens)           AS total_output_tokens,
        0::BIGINT                      AS total_tool_calls,
        0::BIGINT                      AS commits
    FROM fmc_base b
    LEFT JOIN turns_by_date t
        ON t.session_id = b.session_id AND t.tenant_id = b.tenant_id AND t.date = b.date
    WHERE b.app_id IS NOT NULL
    GROUP BY b.tenant_id, b.app_id, b.project_id, b.date
),

-- ── Agent grain ────────────────────────────────────────────────────────────
agent_daily AS (
    SELECT
        b.tenant_id,
        'agent'                        AS entity_type,
        COALESCE(b.agent, 'main')      AS entity_id,
        NULL::VARCHAR                  AS project_id,
        b.date,
        COUNT(DISTINCT b.session_id)   AS session_count,
        COALESCE(SUM(t.turn_count), 0) AS total_turns,
        SUM(b.calculated_cost)         AS total_cost,
        SUM(b.output_tokens)           AS total_output_tokens,
        0::BIGINT                      AS total_tool_calls,
        0::BIGINT                      AS commits
    FROM fmc_base b
    LEFT JOIN turns_by_date t
        ON t.session_id = b.session_id AND t.tenant_id = b.tenant_id AND t.date = b.date
    GROUP BY b.tenant_id, COALESCE(b.agent, 'main'), b.date
),

-- ── Person grain ───────────────────────────────────────────────────────────
person_daily AS (
    SELECT
        b.tenant_id,
        'person'                       AS entity_type,
        b.person_id                    AS entity_id,
        NULL::VARCHAR                  AS project_id,
        b.date,
        COUNT(DISTINCT b.session_id)   AS session_count,
        COALESCE(SUM(t.turn_count), 0) AS total_turns,
        SUM(b.calculated_cost)         AS total_cost,
        SUM(b.output_tokens)           AS total_output_tokens,
        0::BIGINT                      AS total_tool_calls,
        0::BIGINT                      AS commits
    FROM fmc_base b
    LEFT JOIN turns_by_date t
        ON t.session_id = b.session_id AND t.tenant_id = b.tenant_id AND t.date = b.date
    WHERE b.person_id IS NOT NULL AND b.person_id != 'unknown'
    GROUP BY b.tenant_id, b.person_id, b.date
)

SELECT * FROM app_daily
UNION ALL
SELECT * FROM agent_daily
UNION ALL
SELECT * FROM person_daily
