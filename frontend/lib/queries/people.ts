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
