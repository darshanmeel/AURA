-- Grain of int_app_cwd_lookup: (tenant_id, cwd).
SELECT tenant_id, cwd, COUNT(*) AS n
FROM {{ ref('int_app_cwd_lookup') }}
GROUP BY ALL
HAVING COUNT(*) > 1
