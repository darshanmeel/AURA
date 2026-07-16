{{ config(materialized='table') }}

-- Time-of-day activity heatmap over the last 7 complete days (UTC).
-- Grain: (day_of_week, hour_of_day) — at most 7 × 24 = 168 rows.
-- Window: CURRENT_DATE - 7 days to CURRENT_DATE - 1 day (inclusive); today
--         excluded so every bucket is a full hour, not a partial one.
--
-- day_of_week encoding:
--   DuckDB's dayofweek() returns 0=Sunday … 6=Saturday (ISO week starts Sun).
--   We remap to 0=Monday … 6=Sunday via: (dayofweek(ts) + 6) % 7
--   so that the frontend can display a Mon-first grid without extra logic.
--
-- Sources:
--   turn_count     — fact_turns.assistant_ts  (when assistant response landed)
--   total_cost     — fact_model_calls.ts + calculated_cost
--   session_starts — dim_sessions.start_ts (first event in the session)

WITH turn_buckets AS (
    SELECT
        (EXTRACT(DOW FROM assistant_ts)::INTEGER + 6) % 7  AS day_of_week,
        EXTRACT(HOUR FROM assistant_ts)::INTEGER            AS hour_of_day,
        COUNT(*)                                            AS turn_count
    FROM {{ ref('fact_turns') }}
    WHERE CAST(assistant_ts AS DATE) >= CURRENT_DATE - INTERVAL 7 DAYS
      AND CAST(assistant_ts AS DATE) <  CURRENT_DATE
    GROUP BY 1, 2
),

cost_buckets AS (
    SELECT
        (EXTRACT(DOW FROM ts)::INTEGER + 6) % 7             AS day_of_week,
        EXTRACT(HOUR FROM ts)::INTEGER                       AS hour_of_day,
        SUM(calculated_cost)                                 AS total_cost
    FROM {{ ref('fact_model_calls') }}
    WHERE CAST(ts AS DATE) >= CURRENT_DATE - INTERVAL 7 DAYS
      AND CAST(ts AS DATE) <  CURRENT_DATE
    GROUP BY 1, 2
),

session_buckets AS (
    SELECT
        (EXTRACT(DOW FROM start_ts)::INTEGER + 6) % 7       AS day_of_week,
        EXTRACT(HOUR FROM start_ts)::INTEGER                 AS hour_of_day,
        COUNT(*)                                             AS session_starts
    FROM {{ ref('dim_sessions') }}
    WHERE CAST(start_ts AS DATE) >= CURRENT_DATE - INTERVAL 7 DAYS
      AND CAST(start_ts AS DATE) <  CURRENT_DATE
    GROUP BY 1, 2
),

-- Build the full 7 × 24 grid so every cell is present even when activity is
-- zero. This prevents the frontend from needing to fill gaps.
all_dow AS (
    SELECT UNNEST(RANGE(0, 7))  AS day_of_week
),
all_hours AS (
    SELECT UNNEST(RANGE(0, 24)) AS hour_of_day
),
grid AS (
    SELECT d.day_of_week, h.hour_of_day
    FROM all_dow d CROSS JOIN all_hours h
)

SELECT
    g.day_of_week,
    g.hour_of_day,
    COALESCE(tb.turn_count,      0)    AS turn_count,
    COALESCE(cb.total_cost,      0.0)  AS total_cost,
    COALESCE(sb.session_starts,  0)    AS session_starts
FROM grid g
LEFT JOIN turn_buckets    tb ON tb.day_of_week = g.day_of_week AND tb.hour_of_day = g.hour_of_day
LEFT JOIN cost_buckets    cb ON cb.day_of_week = g.day_of_week AND cb.hour_of_day = g.hour_of_day
LEFT JOIN session_buckets sb ON sb.day_of_week = g.day_of_week AND sb.hour_of_day = g.hour_of_day
ORDER BY g.day_of_week, g.hour_of_day
