import { query } from '../db'
import { tsFilter } from './_helpers'

export async function getErrors(since: string | null = null) {
  const wh = tsFilter('e.ts', since)
  return query(`
    SELECT e.ts, e.kind, e.tool, e.message, e.severity, e.session_id, e.turn_number
    FROM fact_errors e
    ${wh}
    ORDER BY e.ts DESC
    LIMIT 500
  `)
}
