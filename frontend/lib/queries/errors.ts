import { query } from '../db'

export async function getErrors() {
  return query(`
    SELECT e.ts, e.kind, e.tool, e.message, e.severity, e.session_id, e.turn_number
    FROM fact_errors e
    ORDER BY e.ts DESC
    LIMIT 500
  `)
}
