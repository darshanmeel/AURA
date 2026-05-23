import { query, queryOne } from '../db'

export async function getAgent(name: string) {
  return queryOne(`
    SELECT agent,
           COUNT(DISTINCT session_id)   AS session_count,
           COUNT(DISTINCT person_id)    AS people_count,
           COUNT(DISTINCT cwd)          AS app_count,
           SUM(total_cost)              AS total_cost,
           SUM(turn_count)              AS total_turns,
           array_agg(DISTINCT model)    AS models,
           MIN(start_ts)                AS first_seen,
           MAX(start_ts)                AS last_seen
    FROM dim_sessions WHERE agent = ? GROUP BY agent
  `, [name])
}

export async function getAgentSessions(name: string) {
  return query(`
    SELECT session_id, start_ts, person_name, cwd, session_title,
           status, turn_count, total_cost
    FROM dim_sessions WHERE agent = ? ORDER BY start_ts DESC LIMIT 20
  `, [name])
}

export async function getAgentFiles(name: string) {
  return query(`
    SELECT f.file_path, f.file_ext, SUM(f.edit_count) AS edits
    FROM fact_session_files f
    JOIN dim_sessions s ON f.session_id = s.session_id
    WHERE s.agent = ? GROUP BY f.file_path, f.file_ext ORDER BY edits DESC LIMIT 10
  `, [name])
}
