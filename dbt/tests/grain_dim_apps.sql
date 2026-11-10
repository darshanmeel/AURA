-- Grain of dim_apps: (tenant_id, app_id, project_id).
SELECT tenant_id, app_id, project_id, COUNT(*) AS n
FROM {{ ref('dim_apps') }}
GROUP BY ALL
HAVING COUNT(*) > 1
