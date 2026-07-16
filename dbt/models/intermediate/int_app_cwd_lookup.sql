{{ config(materialized='table') }}

-- One row per (cwd, app_id, project_id). Lets dim_sessions and other
-- downstream marts attribute every session to its app regardless of which
-- exact cwd variant the session was running in.
--
-- dim_apps stores all_cwds as array_agg(DISTINCT cwd), so every variant
-- (trailing-slash, different checkout path, etc.) is captured here.
-- Previously dim_sessions joined on dim_apps.cwd which was ANY_VALUE —
-- arbitrarily chosen — causing sessions with non-canonical cwd to get
-- NULL app_id (silently orphaned). This lookup fixes that.
SELECT
    da.tenant_id,
    unnest(da.all_cwds) AS cwd,
    da.app_id,
    da.project_id,
    da.app_name
FROM {{ ref('dim_apps') }} da
WHERE da.all_cwds IS NOT NULL AND len(da.all_cwds) > 0
