import { query, queryOne } from '../db'

export async function getApps() {
  return query(`SELECT * FROM dim_apps ORDER BY total_cost DESC`)
}

export async function getApp(appId: string) {
  return queryOne(`SELECT * FROM dim_apps WHERE app_id = ?`, [appId])
}

export async function getAppSessions(appId: string) {
  return query(`
    SELECT session_id, start_ts, end_ts, agent, person_name, session_title,
           status, turn_count, total_cost, commits
    FROM dim_sessions WHERE cwd = ? ORDER BY start_ts DESC LIMIT 20
  `, [appId])
}
