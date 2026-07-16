-- Asserts every distinct model in fact_model_calls has a pricing row in
-- model_pricing. Fails loud and names the exact model IDs that are missing,
-- so the fix (add a row to dbt/seeds/model_pricing.csv + dbt seed) is clear.
-- sdk_trace rows are excluded: those use verbatim reported_cost_usd, not pricing.

SELECT DISTINCT c.model
FROM {{ ref('fact_model_calls') }} c
LEFT JOIN {{ ref('model_pricing') }} mp
    ON c.model = mp.model
   AND (mp.tenant_id IS NULL OR mp.tenant_id = c.tenant_id)
WHERE mp.model IS NULL
  AND c.source != 'sdk_trace'
  AND c.model IS NOT NULL
