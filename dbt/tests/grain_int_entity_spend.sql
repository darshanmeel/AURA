-- Grain of int_entity_spend: (tenant_id, entity_type, entity_id, project_id, date).
SELECT tenant_id, entity_type, entity_id, project_id, date, COUNT(*) AS n
FROM {{ ref('int_entity_spend') }}
GROUP BY ALL
HAVING COUNT(*) > 1
