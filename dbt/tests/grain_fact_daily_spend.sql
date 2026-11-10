-- Grain of fact_daily_spend: (tenant_id, date, agent, model, provider).
SELECT tenant_id, date, agent, model, provider, COUNT(*) AS n
FROM {{ ref('fact_daily_spend') }}
GROUP BY ALL
HAVING COUNT(*) > 1
