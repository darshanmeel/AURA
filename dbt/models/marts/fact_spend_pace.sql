{{ config(materialized='table') }}

-- Current-day burn rate and 30-day rolling averages.
-- One row per tenant. Designed for the "spent $X today, pace = $Y/day,
-- vs 30-day avg $Z/day" dashboard widget.
--
-- Grain:            one row per tenant_id
-- Cost source:      fact_model_calls.calculated_cost (already priced, fail-loud)
-- Turn source:      fact_turns (materialized table; assistant_ts = when the turn
--                  completed). Using fact_turns rather than the int_turns view
--                  keeps the turn-count grain consistent with fact_hourly_activity
--                  and avoids re-executing the view's ASOF JOIN on every refresh.
-- Tool source:      stg_tool_calls (one row per individual tool invocation)
-- "Today" window:   CURRENT_DATE UTC (open interval; includes partial day)
-- "30d window":     [CURRENT_DATE - 30, CURRENT_DATE) — excludes today so the
--                   average is not diluted by a partial day
-- hours_elapsed:    seconds since midnight UTC / 3600; floored at 1 minute to
--                   avoid division-by-zero in the first minute of each day

WITH today_costs AS (
    SELECT
        tenant_id,
        SUM(calculated_cost) AS today_cost
    FROM {{ ref('fact_model_calls') }}
    WHERE CAST(ts AS DATE) = CURRENT_DATE
    GROUP BY tenant_id
),

today_turns AS (
    SELECT
        tenant_id,
        COUNT(*) AS today_turn_count
    FROM {{ ref('fact_turns') }}
    WHERE CAST(assistant_ts AS DATE) = CURRENT_DATE
    GROUP BY tenant_id
),

-- 30-day window: strictly before today
last_30d_costs AS (
    SELECT
        tenant_id,
        CAST(ts AS DATE)           AS day,
        SUM(calculated_cost)       AS daily_cost,
        COUNT(DISTINCT session_id) AS daily_sessions
    FROM {{ ref('fact_model_calls') }}
    WHERE CAST(ts AS DATE) >= CURRENT_DATE - INTERVAL 30 DAYS
      AND CAST(ts AS DATE) <  CURRENT_DATE
    GROUP BY tenant_id, CAST(ts AS DATE)
),

last_30d_turns AS (
    SELECT
        tenant_id,
        CAST(assistant_ts AS DATE) AS day,
        COUNT(*)                   AS daily_turns
    FROM {{ ref('fact_turns') }}
    WHERE CAST(assistant_ts AS DATE) >= CURRENT_DATE - INTERVAL 30 DAYS
      AND CAST(assistant_ts AS DATE) <  CURRENT_DATE
    GROUP BY tenant_id, CAST(assistant_ts AS DATE)
),

last_30d_tools AS (
    SELECT
        tenant_id,
        CAST(ts AS DATE) AS day,
        COUNT(*)         AS daily_tools
    FROM {{ ref('stg_tool_calls') }}
    WHERE CAST(ts AS DATE) >= CURRENT_DATE - INTERVAL 30 DAYS
      AND CAST(ts AS DATE) <  CURRENT_DATE
    GROUP BY tenant_id, CAST(ts AS DATE)
),

-- Aggregate 30-day per-tenant averages.
-- AVG over distinct calendar days that had any activity; days with zero
-- activity are excluded (they do not appear as rows). This matches user
-- mental model: "average active day" not "average calendar day".
avg_30d AS (
    SELECT
        c.tenant_id,
        AVG(c.daily_cost)                                AS avg_30d_cost,
        AVG(COALESCE(t.daily_turns, 0))                  AS avg_30d_turns,
        AVG(COALESCE(tl.daily_tools, 0))                 AS avg_30d_tools
    FROM last_30d_costs c
    LEFT JOIN last_30d_turns t
           ON t.tenant_id = c.tenant_id AND t.day = c.day
    LEFT JOIN last_30d_tools tl
           ON tl.tenant_id = c.tenant_id AND tl.day = c.day
    GROUP BY c.tenant_id
),

-- Union of all tenants seen in any of the above CTEs.
-- Note: "at" is a reserved word in DuckDB; alias is "tnt" throughout.
all_tenants AS (
    SELECT tenant_id FROM today_costs
    UNION
    SELECT tenant_id FROM avg_30d
),

-- Hours elapsed since midnight UTC; minimum 1/60 to prevent div-by-zero.
hours_elapsed AS (
    SELECT
        GREATEST(
            EXTRACT(EPOCH FROM (NOW() - CAST(CURRENT_DATE AS TIMESTAMP))) / 3600.0,
            1.0 / 60.0
        ) AS h
)

SELECT
    tnt.tenant_id,
    COALESCE(tc.today_cost, 0.0)                         AS today_cost,
    -- Current hourly burn rate = today's spend / hours elapsed today. This MUST
    -- stay an hourly rate: the frontend (BurnRate.tsx) multiplies it by 24 to
    -- project a full day. The earlier `* 24.0` here baked the projection in too,
    -- so the dashboard double-counted and showed a pace 24x too high
    -- ($6011/day instead of $250/day). Name now matches the value.
    COALESCE(tc.today_cost, 0.0) / he.h                  AS today_pace_hourly,
    COALESCE(a.avg_30d_cost, 0.0)                        AS avg_30d_cost,
    COALESCE(a.avg_30d_turns, 0.0)                       AS avg_30d_turns,
    COALESCE(a.avg_30d_tools, 0.0)                       AS avg_30d_tools,
    -- Ancillary: raw today counts for spot-check / debug
    COALESCE(tt.today_turn_count, 0)                     AS today_turn_count,
    he.h                                                  AS hours_elapsed_today,
    CURRENT_TIMESTAMP                                     AS refreshed_at
FROM all_tenants tnt
CROSS JOIN hours_elapsed he
LEFT JOIN today_costs tc   ON tc.tenant_id = tnt.tenant_id
LEFT JOIN today_turns tt   ON tt.tenant_id = tnt.tenant_id
LEFT JOIN avg_30d a        ON a.tenant_id  = tnt.tenant_id
