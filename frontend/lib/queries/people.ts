import { query, queryOne } from '../db'

export async function getPeople() {
  return query(`SELECT * FROM dim_people ORDER BY total_cost DESC`)
}

export async function getPerson(personId: string) {
  return queryOne(`SELECT * FROM dim_people WHERE person_id = ?`, [personId])
}

export async function getPersonSessions(personId: string) {
  return query(`
    SELECT session_id, start_ts, end_ts, cwd, agent, session_title,
           status, turn_count, total_cost, commits
    FROM dim_sessions WHERE person_id = ? ORDER BY start_ts DESC LIMIT 20
  `, [personId])
}

export async function getPersonAgents(personId: string) {
  return query(`
    SELECT ds.agent,
           COUNT(DISTINCT ds.session_id) AS session_count,
           SUM(ds.turn_count)            AS total_turns,
           SUM(ds.total_cost)            AS total_cost
    FROM dim_sessions ds
    WHERE ds.person_id = ?
      AND ds.agent IS NOT NULL
    GROUP BY ds.agent
    ORDER BY total_cost DESC
  `, [personId])
}

export async function getPersonApps(personId: string) {
  return query(`
    SELECT da.app_id,
           COALESCE(da.app_name, da.app_id) AS app_name,
           COUNT(DISTINCT ds.session_id)    AS session_count,
           SUM(ds.turn_count)               AS total_turns,
           SUM(ds.total_cost)               AS total_cost
    FROM dim_sessions ds
    INNER JOIN dim_apps da ON da.cwd = ds.cwd
    WHERE ds.person_id = ?
      AND da.app_id IS NOT NULL
    GROUP BY da.app_id, da.app_name
    ORDER BY total_cost DESC
  `, [personId])
}

export async function getPersonPrompts(personId: string, limit = 8) {
  return query(`
    SELECT fp.prompt_ts, fp.prompt_text_200, fp.agent, fp.app_id,
           fp.turn_count, fp.tool_call_count, fp.files_edited, fp.cost_total
    FROM fact_prompts fp
    JOIN dim_sessions ds USING (session_id)
    WHERE ds.person_id = ?
    ORDER BY fp.prompt_ts DESC
    LIMIT ?
  `, [personId, limit])
}
