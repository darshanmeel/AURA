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
        COUNT(DISTINCT ft.session_id)              AS session_count,
        SUM(ft.output_tokens)                      AS total_output_tokens,
        COALESCE(SUM(ft.calculated_cost), 0)       AS total_cost,
        COUNT(*)                                   AS total_turns,
        MIN(ft.assistant_ts)                       AS first_seen,
        MAX(ft.assistant_ts)                       AS last_seen
    FROM session_list sl
    JOIN {{ ref('fact_turns') }} ft
        ON ft.session_id = sl.session_id AND ft.tenant_id = sl.tenant_id
    GROUP BY sl.tenant_id, sl.app_id, sl.project_id
),
-- Commits per app, derived from fact_git_commands (successful `git commit`
-- Bash invocations per session, summed over the app's sessions). We pull from
-- fact_git_commands rather than stg_session_meta because the watcher never
-- populates session_meta.commits — the column defaults to 0 forever. Sourcing
-- from fact_git_commands keeps every page (dashboard, /apps, /agents, /people,
-- session detail) reconciled to the same definition of "commit".
-- We deliberately avoid ref('dim_sessions') here: int_app_cwd_lookup unnests
-- dim_apps.all_cwds, and dim_sessions joins through int_app_cwd_lookup, so
-- pulling dim_sessions into dim_apps creates a circular DAG.
commit_stats AS (
    SELECT
        sl.tenant_id,
        sl.app_id,
        sl.project_id,
        COUNT(*)                                   AS commits
    FROM session_list sl
    JOIN {{ ref('fact_git_commands') }} gc
        ON gc.session_id = sl.session_id
    WHERE gc.git_op = 'commit'
      AND NOT gc.is_error
      AND gc.raw_command NOT LIKE '%--help%'
    GROUP BY sl.tenant_id, sl.app_id, sl.project_id
),
-- Distinct agents per app, sourced from int_event_agent (resolved agent per
-- assistant event). One row per (session, agent) in agents_per_session;
-- COUNT DISTINCT collapses to per-(app, project).
session_agents AS (
    SELECT DISTINCT
        e.tenant_id,
        e.session_id,
        COALESCE(ea.agent_resolved, 'main')        AS agent
    FROM {{ ref('stg_events') }} e
    LEFT JOIN {{ ref('int_event_agent') }} ea
        ON ea.tenant_id = e.tenant_id AND ea.event_uuid = e.uuid
    WHERE e.event_type = 'assistant'
),
agent_stats AS (
    SELECT
        sl.tenant_id,
        sl.app_id,
        sl.project_id,
        COUNT(DISTINCT sa.agent)                   AS agent_count
    FROM session_list sl
    LEFT JOIN session_agents sa
        ON sa.tenant_id = sl.tenant_id AND sa.session_id = sl.session_id
    GROUP BY sl.tenant_id, sl.app_id, sl.project_id
),
-- Errors per app — count rows in fact_errors that belong to sessions in this app.
error_stats AS (
    SELECT
        sl.tenant_id,
        sl.app_id,
        sl.project_id,
        COUNT(fe.session_id)                       AS errors
    FROM session_list sl
    LEFT JOIN {{ ref('fact_errors') }} fe
        ON fe.session_id = sl.session_id
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
    COALESCE(cs.commits,        0)         AS commits,
    COALESCE(ags.agent_count,   0)         AS agent_count,
    COALESCE(es.errors,         0)         AS errors,
    ts.first_seen,
    ts.last_seen
FROM app_cwd ac
LEFT JOIN turn_stats   ts  USING (tenant_id, app_id, project_id)
LEFT JOIN commit_stats cs  USING (tenant_id, app_id, project_id)
LEFT JOIN agent_stats  ags USING (tenant_id, app_id, project_id)
LEFT JOIN error_stats  es  USING (tenant_id, app_id, project_id)
