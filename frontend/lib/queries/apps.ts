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
  // Range filter: read from pre-aggregated int_entity_spend (date-grain table).
  // `errors` is not derivable without a timestamp on fact_errors; return NULL
  // and let the UI render `—` (apps/page.tsx already handles `app.errors != null`).
  return query(`
    SELECT
      es.entity_id                                         AS app_id,
      COALESCE(da.app_name, da.app_id, es.entity_id)      AS app_name,
      COALESCE(es.project_id, da.project_id)              AS project_id,
      ANY_VALUE(da.cwd)                                    AS cwd,
      ANY_VALUE(da.all_cwds)                               AS all_cwds,
      SUM(es.session_count)                                AS session_count,
      SUM(es.total_turns)                                  AS total_turns,
      SUM(es.total_cost)                                   AS total_cost,
      SUM(es.total_output_tokens)                          AS total_output_tokens,
      SUM(es.commits)                                      AS commits,
      NULL::BIGINT                                         AS agent_count,
      NULL::VARCHAR[]                                      AS agents,
      MIN(da.first_seen)                                   AS first_seen,
      MAX(da.last_seen)                                    AS last_seen,
      NULL                                                 AS errors
    FROM int_entity_spend es
    LEFT JOIN dim_apps da ON da.app_id = es.entity_id AND da.tenant_id = es.tenant_id
    WHERE es.entity_type = 'app'
      AND es.date >= '${since}'::DATE
    GROUP BY es.entity_id,
             COALESCE(da.app_name, da.app_id, es.entity_id),
             COALESCE(es.project_id, da.project_id)
    ORDER BY total_cost DESC NULLS LAST
  `)
}

export async function getAppsTotalCost(since: string | null = null) {
  const wh = since ? `WHERE date >= '${since}'::DATE` : ''
  return queryOne(`SELECT COALESCE(SUM(total_cost), 0) AS total_cost FROM int_entity_spend ${wh}`)
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
  // Range path: join fact_model_calls for accurate date-filtered cost.
  return query(`
    SELECT
      fmc.agent                              AS agent,
      COUNT(DISTINCT fmc.session_id)         AS session_count,
      SUM(ds.turn_count)                     AS total_turns,
      SUM(fmc.calculated_cost)               AS total_cost,
      SUM(ds.tools_used)                     AS total_tool_calls
    FROM fact_model_calls fmc
    JOIN dim_sessions ds ON ds.session_id = fmc.session_id
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd AND da.tenant_id = ds.tenant_id
    WHERE da.app_id = '${appId}'
      AND CAST(fmc.ts AS DATE) >= '${since}'::DATE
      AND fmc.agent IS NOT NULL
    GROUP BY fmc.agent
    ORDER BY total_cost DESC
  `)
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
  // Fast path: lifetime mart.
  if (!since) {
    return query(`
      SELECT ds.person_id, ds.person_name,
             COUNT(DISTINCT ds.session_id)  AS session_count,
             SUM(ds.turn_count)             AS total_turns,
             SUM(ds.total_cost)             AS total_cost
      FROM dim_sessions ds
      LEFT JOIN dim_apps da ON da.cwd = ds.cwd
      WHERE da.app_id = ?
        AND ds.person_id IS NOT NULL
      GROUP BY ds.person_id, ds.person_name
      ORDER BY total_cost DESC
    `, [appId])
  }
  // Range path: join fact_model_calls for accurate date-filtered cost.
  return query(`
    SELECT
      ds.person_id,
      ds.person_name,
      COUNT(DISTINCT fmc.session_id)   AS session_count,
      SUM(ds.turn_count)               AS total_turns,
      SUM(fmc.calculated_cost)         AS total_cost
    FROM fact_model_calls fmc
    JOIN dim_sessions ds ON ds.session_id = fmc.session_id
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd AND da.tenant_id = ds.tenant_id
    WHERE da.app_id = '${appId}'
      AND CAST(fmc.ts AS DATE) >= '${since}'::DATE
      AND ds.person_id IS NOT NULL
    GROUP BY ds.person_id, ds.person_name
    ORDER BY total_cost DESC
  `)
}

/**
 * Range-aware aggregates for the app header KPIs. Returns null for `since=null`
 * to let the page fall back to the lifetime `dim_apps` mart.
 */
export async function getAppRangeAggregates(appId: string, since: string | null) {
  if (!since) return null
  // Range path: int_entity_spend gives session_count, turns, cost, commits.
  // total_output_tokens and agent_count are not in int_entity_spend; return NULL.
  // The app header KPI grid only renders columns that are non-null.
  return queryOne(`
    SELECT
      SUM(es.session_count)            AS session_count,
      SUM(es.total_turns)              AS total_turns,
      SUM(es.total_cost)               AS total_cost,
      NULL::BIGINT                     AS total_output_tokens,
      SUM(es.commits)                  AS commits,
      NULL::BIGINT                     AS agent_count
    FROM int_entity_spend es
    WHERE es.entity_type = 'app'
      AND es.entity_id = ?
      AND es.date >= '${since}'::DATE
  `, [appId])
}
