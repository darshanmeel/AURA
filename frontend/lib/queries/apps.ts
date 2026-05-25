import { query, queryOne } from '../db'

const APP_SESSIONS_LIMIT = 12

function tsFilter(col: string, since: string | null): string {
  if (!since) return ''
  return `WHERE ${col} >= '${since}'`
}

export async function getApps(since: string | null = null) {
  // No range filter: lifetime mart is the right answer (fast path).
  if (!since) {
    return query(`SELECT * FROM dim_apps ORDER BY total_cost DESC`)
  }
  // Range filter: re-aggregate from dim_sessions, joining lookup tables
  // for the naming/identity columns the dashboard's getTopApps pattern uses.
  // `errors` is not derivable from dim_sessions alone; return NULL and let the
  // UI render `—` (apps/page.tsx already handles `app.errors != null`).
  return query(`
    SELECT
      COALESCE(da.app_id, al.app_id, ds.cwd)              AS app_id,
      COALESCE(da.app_name, da.app_id, al.app_id, ds.cwd) AS app_name,
      COALESCE(da.project_id, al.project_id)              AS project_id,
      ANY_VALUE(da.cwd)                                    AS cwd,
      ANY_VALUE(da.all_cwds)                               AS all_cwds,
      COUNT(DISTINCT ds.session_id)                        AS session_count,
      SUM(ds.turn_count)                                   AS total_turns,
      SUM(ds.total_cost)                                   AS total_cost,
      SUM(ds.total_output_tokens)                          AS total_output_tokens,
      SUM(ds.commits)                                      AS commits,
      COUNT(DISTINCT ds.agent)                             AS agent_count,
      ARRAY_AGG(DISTINCT ds.agent)                         AS agents,
      MIN(ds.start_ts)                                     AS first_seen,
      MAX(ds.start_ts)                                     AS last_seen,
      NULL                                                 AS errors
    FROM dim_sessions ds
    LEFT JOIN int_app_cwd_lookup al ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id
    LEFT JOIN dim_apps da ON da.app_id = al.app_id AND da.tenant_id = al.tenant_id
    WHERE ds.start_ts >= '${since}'
    GROUP BY 1, 2, 3
    ORDER BY total_cost DESC NULLS LAST
  `)
}

export async function getAppsTotalCost(since: string | null = null) {
  const wh = tsFilter('start_ts', since)
  return queryOne(`SELECT SUM(total_cost) AS total_cost FROM dim_sessions ${wh}`)
}

export async function getProjectApps(projectId: string) {
  return query(`
    SELECT app_id, app_name, total_cost, session_count, total_turns
    FROM dim_apps
    WHERE project_id = ?
    ORDER BY total_cost DESC
  `, [projectId])
}

export async function getApp(appId: string) {
  return queryOne(`
    SELECT da.*, dp.project_name
    FROM dim_apps da
    LEFT JOIN dim_projects dp USING (project_id, tenant_id)
    WHERE da.app_id = ?
  `, [appId])
}

export async function getAppAgents(appId: string, since: string | null = null) {
  // Fast path: lifetime mart.
  if (!since) {
    return query(`
      SELECT agent, session_count, total_turns, total_cost, total_tool_calls
      FROM dim_agents WHERE app_id = ?
      ORDER BY total_cost DESC
    `, [appId])
  }
  // Range path: re-aggregate from dim_sessions for this app's cwds.
  return query(`
    SELECT
      ds.agent                            AS agent,
      COUNT(DISTINCT ds.session_id)       AS session_count,
      SUM(ds.turn_count)                  AS total_turns,
      SUM(ds.total_cost)                  AS total_cost,
      SUM(ds.tools_used)                  AS total_tool_calls
    FROM dim_sessions ds
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd
    WHERE da.app_id = ?
      AND ds.start_ts >= '${since}'
      AND ds.agent IS NOT NULL
    GROUP BY ds.agent
    ORDER BY total_cost DESC
  `, [appId])
}

export async function getAppSessions(appId: string, limit = APP_SESSIONS_LIMIT, since: string | null = null) {
  const sinceClause = since ? ` AND ds.start_ts >= '${since}'` : ''
  return query(`
    SELECT ds.session_id, ds.start_ts, ds.end_ts, ds.model, ds.agent,
           ds.turn_count, ds.total_cost, ds.session_title
    FROM dim_sessions ds
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd
    WHERE da.app_id = ?${sinceClause}
    ORDER BY ds.start_ts DESC
    LIMIT ?
  `, [appId, limit])
}

export async function getAppPeople(appId: string, since: string | null = null) {
  const sinceClause = since ? ` AND ds.start_ts >= '${since}'` : ''
  return query(`
    SELECT ds.person_id, ds.person_name,
           COUNT(DISTINCT ds.session_id)  AS session_count,
           SUM(ds.turn_count)             AS total_turns,
           SUM(ds.total_cost)             AS total_cost
    FROM dim_sessions ds
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd
    WHERE da.app_id = ?
      AND ds.person_id IS NOT NULL${sinceClause}
    GROUP BY ds.person_id, ds.person_name
    ORDER BY total_cost DESC
  `, [appId])
}

/**
 * Range-aware aggregates for the app header KPIs. Returns null for `since=null`
 * to let the page fall back to the lifetime `dim_apps` mart.
 */
export async function getAppRangeAggregates(appId: string, since: string | null) {
  if (!since) return null
  return queryOne(`
    SELECT
      COUNT(DISTINCT ds.session_id)                  AS session_count,
      SUM(ds.turn_count)                             AS total_turns,
      SUM(ds.total_cost)                             AS total_cost,
      SUM(ds.total_output_tokens)                    AS total_output_tokens,
      SUM(ds.commits)                                AS commits,
      COUNT(DISTINCT ds.agent)                       AS agent_count
    FROM dim_sessions ds
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd
    WHERE da.app_id = ?
      AND ds.start_ts >= '${since}'
  `, [appId])
}
