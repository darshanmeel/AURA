import { query, queryOne } from '../db'

export async function getApps() {
  return query(`SELECT * FROM dim_apps ORDER BY total_cost DESC`)
}

export async function getAppsTotalCost() {
  return queryOne(`SELECT SUM(total_cost) AS total_cost FROM dim_sessions`)
}

export async function getApp(appId: string) {
  return queryOne(`
    SELECT da.*, dp.project_name
    FROM dim_apps da
    LEFT JOIN dim_projects dp USING (project_id, tenant_id)
    WHERE da.app_id = ?
  `, [appId])
}

export async function getAppAgents(appId: string) {
  return query(`
    SELECT agent, session_count, total_turns, total_cost, total_tool_calls
    FROM dim_agents WHERE app_id = ?
    ORDER BY total_cost DESC
  `, [appId])
}

export async function getAppSessions(appId: string, limit = 12) {
  return query(`
    SELECT ds.session_id, ds.start_ts, ds.end_ts, ds.model, ds.agent,
           ds.turn_count, ds.total_cost, ds.session_title
    FROM dim_sessions ds
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd
    WHERE da.app_id = ?
    ORDER BY ds.start_ts DESC
    LIMIT ?
  `, [appId, limit])
}
