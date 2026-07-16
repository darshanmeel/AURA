{{ config(materialized='table') }}

-- ─────────────────────────────────────────────────────────────────────────────
-- int_entity_spend: daily-grain spend roll-up keyed by entity type + ID.
-- Grain: (tenant_id, entity_type, entity_id, date)
--
-- MATERIALIZATION CHAIN & ATOMICITY CAVEAT (D-C4)
-- ─────────────────────────────────────────────────────────────────────────────
-- This model sits at the deepest node of the dbt DAG and is queried directly
-- by the frontend API.  The full upstream chain is:
--
--   stg_events
--     └─ fact_model_calls        (cost anchored to event ts — never session start_ts)
--          └─ fact_turns
--               └─ dim_sessions
--                    └─ int_entity_spend   ← this model
--
-- dbt-duckdb does NOT run the chain atomically.  If a dbt run is aborted,
-- killed, or fails mid-cycle the frontend may read this table while upstream
-- marts are already refreshed for a newer time window.  Symptoms:
--
--   • entity totals appear lower than fact_daily_spend for the same period
--     (fact_model_calls refreshed; int_entity_spend not yet rebuilt)
--   • OR entity totals appear higher than expected
--     (dim_sessions rebuilt with new sessions that int_entity_spend still
--      carries from a previous snapshot's session_commits join)
--
-- Mitigation: the watcher releases the write lock only after the full dbt
-- build completes (spec §3).  A partial run therefore only occurs on SIGKILL
-- or DuckDB crash.  In that case, re-run `dbt build --select +int_entity_spend`
-- to make all upstreams consistent before the frontend reads again.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Time attribution:
--   cost / turns / output_tokens — use event timestamp (fact_model_calls.ts)
--     so totals match fact_daily_spend and fact_spend_pace for the same period
--   tool_calls — use tool_call_ts (fact_tool_executions)
--   commits   — use session start_ts (commits are session-level, no per-event ts)
--
-- IMPORTANT design note: we aggregate per grain × date in separate CTEs and
-- LEFT JOIN them at the grain level — NOT by joining session-date helpers into
-- a per-event fact and SUM'ing. The per-event approach (fmc_base × turns_by_date)
-- multiplies the joined column by the per-(session, date) event count.

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

-- Per-session commits attributed to start_ts date. Joined to entity by id.
session_commits AS (
    SELECT
        ds.tenant_id,
        ds.session_id,
        ds.person_id,
        COALESCE(ds.agent, 'main')          AS agent,
        al.app_id,
        CAST(ds.start_ts AS DATE)           AS date,
        COALESCE(ds.commits, 0)             AS commits
    FROM {{ ref('dim_sessions') }} ds
    LEFT JOIN {{ ref('int_app_cwd_lookup') }} al
        ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id
    WHERE COALESCE(ds.commits, 0) > 0
),

-- Tool executions enriched with entity keys.
tool_base AS (
    SELECT
        fte.tenant_id,
        CAST(fte.tool_call_ts AS DATE)      AS date,
        fte.session_id,
        ds.person_id,
        COALESCE(ds.agent, 'main')          AS agent,
        al.app_id
    FROM {{ ref('fact_tool_executions') }} fte
    LEFT JOIN {{ ref('dim_sessions') }} ds
        ON ds.session_id = fte.session_id AND ds.tenant_id = fte.tenant_id
    LEFT JOIN {{ ref('int_app_cwd_lookup') }} al
        ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id
),

-- ── App grain: aggregate-then-join, no multiplication ──────────────────────
app_spend AS (
    SELECT
        tenant_id, app_id AS entity_id, project_id, date,
        COUNT(DISTINCT session_id)          AS session_count,
        COUNT(*)                            AS total_turns,
        SUM(calculated_cost)                AS total_cost,
        SUM(output_tokens)                  AS total_output_tokens
    FROM fmc_base
    WHERE app_id IS NOT NULL
    GROUP BY tenant_id, app_id, project_id, date
),
app_tools AS (
    SELECT tenant_id, app_id AS entity_id, date, COUNT(*) AS total_tool_calls
    FROM tool_base WHERE app_id IS NOT NULL
    GROUP BY tenant_id, app_id, date
),
app_commits AS (
    SELECT tenant_id, app_id AS entity_id, date, SUM(commits) AS commits
    FROM session_commits WHERE app_id IS NOT NULL
    GROUP BY tenant_id, app_id, date
),
app_daily AS (
    SELECT
        s.tenant_id,
        'app'                               AS entity_type,
        s.entity_id,
        s.project_id,
        s.date,
        s.session_count,
        s.total_turns,
        s.total_cost,
        s.total_output_tokens,
        COALESCE(t.total_tool_calls, 0)     AS total_tool_calls,
        COALESCE(c.commits, 0)              AS commits
    FROM app_spend s
    LEFT JOIN app_tools   t USING (tenant_id, entity_id, date)
    LEFT JOIN app_commits c USING (tenant_id, entity_id, date)
),

-- ── Agent grain ────────────────────────────────────────────────────────────
agent_spend AS (
    SELECT
        tenant_id,
        COALESCE(agent, 'main')             AS entity_id,
        NULL::VARCHAR                       AS project_id,
        date,
        COUNT(DISTINCT session_id)          AS session_count,
        COUNT(*)                            AS total_turns,
        SUM(calculated_cost)                AS total_cost,
        SUM(output_tokens)                  AS total_output_tokens
    FROM fmc_base
    GROUP BY tenant_id, COALESCE(agent, 'main'), date
),
agent_tools AS (
    SELECT tenant_id, agent AS entity_id, date, COUNT(*) AS total_tool_calls
    FROM tool_base
    GROUP BY tenant_id, agent, date
),
agent_commits AS (
    SELECT tenant_id, agent AS entity_id, date, SUM(commits) AS commits
    FROM session_commits
    GROUP BY tenant_id, agent, date
),
agent_daily AS (
    SELECT
        s.tenant_id,
        'agent'                             AS entity_type,
        s.entity_id,
        s.project_id,
        s.date,
        s.session_count,
        s.total_turns,
        s.total_cost,
        s.total_output_tokens,
        COALESCE(t.total_tool_calls, 0)     AS total_tool_calls,
        COALESCE(c.commits, 0)              AS commits
    FROM agent_spend s
    LEFT JOIN agent_tools   t USING (tenant_id, entity_id, date)
    LEFT JOIN agent_commits c USING (tenant_id, entity_id, date)
),

-- ── Person grain ───────────────────────────────────────────────────────────
person_spend AS (
    SELECT
        tenant_id,
        person_id                           AS entity_id,
        NULL::VARCHAR                       AS project_id,
        date,
        COUNT(DISTINCT session_id)          AS session_count,
        COUNT(*)                            AS total_turns,
        SUM(calculated_cost)                AS total_cost,
        SUM(output_tokens)                  AS total_output_tokens
    FROM fmc_base
    WHERE person_id IS NOT NULL AND person_id != 'unknown'
    GROUP BY tenant_id, person_id, date
),
person_tools AS (
    SELECT tenant_id, person_id AS entity_id, date, COUNT(*) AS total_tool_calls
    FROM tool_base
    WHERE person_id IS NOT NULL AND person_id != 'unknown'
    GROUP BY tenant_id, person_id, date
),
person_commits AS (
    SELECT tenant_id, person_id AS entity_id, date, SUM(commits) AS commits
    FROM session_commits
    WHERE person_id IS NOT NULL AND person_id != 'unknown'
    GROUP BY tenant_id, person_id, date
),
person_daily AS (
    SELECT
        s.tenant_id,
        'person'                            AS entity_type,
        s.entity_id,
        s.project_id,
        s.date,
        s.session_count,
        s.total_turns,
        s.total_cost,
        s.total_output_tokens,
        COALESCE(t.total_tool_calls, 0)     AS total_tool_calls,
        COALESCE(c.commits, 0)              AS commits
    FROM person_spend s
    LEFT JOIN person_tools   t USING (tenant_id, entity_id, date)
    LEFT JOIN person_commits c USING (tenant_id, entity_id, date)
)

SELECT * FROM app_daily
UNION ALL
SELECT * FROM agent_daily
UNION ALL
SELECT * FROM person_daily
