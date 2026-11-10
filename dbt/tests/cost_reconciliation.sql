-- Every cost rollup must equal SUM(fact_model_calls.calculated_cost) per tenant
-- (within 0.01). Returns one row per check that is off. Intentional subsets
-- are a WHERE on the fact_model_calls side, each with a one-line reason.
WITH fmc AS (
    SELECT fmc.tenant_id, fmc.calculated_cost, fmc.cwd, ds.person_id
    FROM {{ ref('fact_model_calls') }} fmc
    LEFT JOIN {{ ref('dim_sessions') }} ds
        ON ds.tenant_id = fmc.tenant_id AND ds.session_id = fmc.session_id
),
expected AS (
    SELECT
        tenant_id,
        COALESCE(SUM(calculated_cost), 0)                                      AS all_calls,
        -- apps only see calls whose cwd is known (cwd -> app via int_app_cwd_lookup)
        COALESCE(SUM(calculated_cost) FILTER (WHERE cwd IS NOT NULL), 0)       AS with_cwd,
        -- person grain skips sessions with no known person
        COALESCE(SUM(calculated_cost) FILTER (WHERE person_id IS NOT NULL AND person_id <> 'unknown'), 0) AS with_person
    FROM fmc
    GROUP BY tenant_id
),
actual AS (
    SELECT tenant_id, 'fact_daily_spend' AS rollup, SUM(daily_cost) AS cost
    FROM {{ ref('fact_daily_spend') }} GROUP BY tenant_id
    UNION ALL
    SELECT tenant_id, 'dim_sessions', SUM(total_cost)
    FROM {{ ref('dim_sessions') }} GROUP BY tenant_id
    UNION ALL
    SELECT tenant_id, 'fact_turns', SUM(calculated_cost)
    FROM {{ ref('fact_turns') }} GROUP BY tenant_id
    UNION ALL
    SELECT tenant_id, 'dim_agents', SUM(total_cost)
    FROM {{ ref('dim_agents') }} GROUP BY tenant_id
    UNION ALL
    SELECT tenant_id, 'dim_apps', SUM(total_cost)
    FROM {{ ref('dim_apps') }} GROUP BY tenant_id
    UNION ALL
    SELECT tenant_id, 'int_entity_spend.' || entity_type, SUM(total_cost)
    FROM {{ ref('int_entity_spend') }} GROUP BY tenant_id, entity_type
),
rollups AS (
    SELECT * FROM (VALUES
        ('fact_daily_spend'), ('dim_sessions'), ('fact_turns'), ('dim_agents'), ('dim_apps'),
        ('int_entity_spend.app'), ('int_entity_spend.agent'), ('int_entity_spend.person')
    ) AS t(rollup)
),
compared AS (
    SELECT
        e.tenant_id,
        r.rollup,
        CASE
            WHEN r.rollup IN ('dim_apps', 'int_entity_spend.app') THEN e.with_cwd
            WHEN r.rollup = 'int_entity_spend.person'              THEN e.with_person
            ELSE e.all_calls
        END                      AS expected_cost,
        COALESCE(a.cost, 0)      AS actual_cost
    FROM expected e
    CROSS JOIN rollups r
    LEFT JOIN actual a ON a.tenant_id = e.tenant_id AND a.rollup = r.rollup
)
SELECT * FROM compared WHERE abs(expected_cost - actual_cost) > 0.01
