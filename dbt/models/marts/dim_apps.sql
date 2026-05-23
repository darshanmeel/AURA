{{ config(materialized='table') }}

-- Maps every distinct cwd → (app_id, project_id) using directory-segment parsing.
-- Apps are directories immediately under apps/, services/, or packages/ segments.
-- If none of those segments are present, app_id = project_id = last path component.
--
-- Avoids referencing dim_sessions to prevent a circular dependency:
-- dim_sessions → dim_apps (for app_id) and dim_apps → dim_sessions (for stats).
-- Stats are derived from fact_turns which has no back-dependency on dim_apps.

WITH cwds AS (
    SELECT DISTINCT tenant_id, cwd, session_id
    FROM {{ ref('stg_events') }}
    WHERE cwd IS NOT NULL
),
parsed AS (
    SELECT
        tenant_id,
        cwd,
        session_id,
        string_split(replace(cwd, '\', '/'), '/') AS parts
    FROM cwds
),
classify AS (
    SELECT
        tenant_id,
        cwd,
        session_id,
        parts,
        list_position(parts, 'apps')     AS apps_idx,
        list_position(parts, 'services') AS svc_idx,
        list_position(parts, 'packages') AS pkg_idx,
        len(parts)                       AS n
    FROM parsed
),
naming AS (
    SELECT
        tenant_id,
        cwd,
        session_id,
        CASE
            WHEN apps_idx > 0 AND apps_idx < n THEN parts[apps_idx + 1]
            WHEN svc_idx  > 0 AND svc_idx  < n THEN parts[svc_idx  + 1]
            WHEN pkg_idx  > 0 AND pkg_idx  < n THEN parts[pkg_idx  + 1]
            ELSE parts[n]
        END                              AS app_id,
        CASE
            WHEN apps_idx > 0            THEN parts[apps_idx - 1]
            WHEN svc_idx  > 0            THEN parts[svc_idx  - 1]
            WHEN pkg_idx  > 0            THEN parts[pkg_idx  - 1]
            ELSE parts[n]
        END                              AS project_id
    FROM classify
),
-- Collapse to one row per (tenant_id, app_id, project_id) — pick an arbitrary cwd
-- as the canonical cwd (used downstream for dim_sessions join).
app_cwd AS (
    SELECT
        tenant_id,
        app_id,
        project_id,
        ANY_VALUE(cwd)           AS cwd,
        array_agg(DISTINCT cwd)  AS all_cwds
    FROM naming
    GROUP BY tenant_id, app_id, project_id
),
-- Stats from fact_turns so we avoid circular dependency with dim_sessions.
session_list AS (
    -- distinct sessions per (tenant_id, cwd)
    SELECT DISTINCT n.tenant_id, n.app_id, n.project_id, n.session_id
    FROM naming n
),
turn_stats AS (
    SELECT
        sl.tenant_id,
        sl.app_id,
        sl.project_id,
        COUNT(DISTINCT ft.session_id)          AS session_count,
        SUM(ft.output_tokens)                  AS total_output_tokens,
        COALESCE(SUM(mc.calculated_cost), 0)   AS total_cost,
        COUNT(*)                               AS total_turns,
        MIN(ft.assistant_ts)                   AS first_seen,
        MAX(ft.assistant_ts)                   AS last_seen
    FROM session_list sl
    JOIN {{ ref('fact_turns') }} ft
        ON ft.session_id = sl.session_id AND ft.tenant_id = sl.tenant_id
    LEFT JOIN {{ ref('fact_model_calls') }} mc
        ON mc.event_uuid = ft.assistant_event_uuid AND mc.tenant_id = ft.tenant_id
    GROUP BY sl.tenant_id, sl.app_id, sl.project_id
)
SELECT
    ac.tenant_id,
    ac.app_id,
    ac.app_id                              AS app_name,
    ac.project_id,
    ac.cwd,
    ac.all_cwds,
    COALESCE(ts.session_count,  0)         AS session_count,
    COALESCE(ts.total_turns,    0)         AS total_turns,
    COALESCE(ts.total_cost,     0)         AS total_cost,
    COALESCE(ts.total_output_tokens, 0)    AS total_output_tokens,
    ts.first_seen,
    ts.last_seen
FROM app_cwd ac
LEFT JOIN turn_stats ts USING (tenant_id, app_id, project_id)
