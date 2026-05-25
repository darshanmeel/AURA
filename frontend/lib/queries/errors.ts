import { query, queryOne } from '../db'

function tsFilter(col: string, since: string | null): string {
  if (!since) return ''
  return `WHERE ${col} >= '${since}'`
}

function andTsFilter(col: string, since: string | null): string {
  if (!since) return ''
  return `AND ${col} >= '${since}'`
}

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

/** Five KPI numbers for the errors hero strip. */
export async function getErrorsSummary(since: string | null = null) {
  const wh = since ? `WHERE ts >= '${since}'` : `WHERE ts >= NOW() - INTERVAL '14 days'`
  return queryOne(`
    SELECT
      COUNT(*)                                              AS total_events,
      SUM(CASE WHEN severity = 'error' THEN 1 ELSE 0 END)  AS hard_errors,
      SUM(CASE WHEN severity = 'warn'  THEN 1 ELSE 0 END)  AS warnings,
      SUM(CASE WHEN severity = 'info'  THEN 1 ELSE 0 END)  AS info_events,
      COUNT(DISTINCT session_id)                            AS sessions_affected,
      SUM(CASE WHEN kind = 'tool_error' THEN 1 ELSE 0 END) AS tool_failures
    FROM fact_errors
    ${wh}
  `)
}

/** Per-kind counts for the chip filter row. */
export async function getErrorsByKind(since: string | null = null) {
  const wh = since ? `WHERE ts >= '${since}'` : `WHERE ts >= NOW() - INTERVAL '14 days'`
  return query(`
    SELECT kind, COUNT(*) AS cnt
    FROM fact_errors
    ${wh}
    GROUP BY kind
    ORDER BY cnt DESC
  `)
}

/**
 * Full error rows, optionally filtered by kind.
 * Joins dim_sessions to surface session_title + agent for the "Session" column.
 */
export async function getErrorsFiltered(kind?: string, since?: string | null) {
  const params: unknown[] = []
  const kindClause = kind && kind !== 'All' ? `AND e.kind = ?` : ''
  const tsClause = since ? `AND e.ts >= '${since}'` : `AND e.ts >= NOW() - INTERVAL '14 days'`
  if (kind && kind !== 'All') params.push(kind)

  return query(`
    SELECT
      e.ts, e.severity, e.kind, e.tool, e.message,
      e.session_id, e.turn_number,
      COALESCE(ds.session_title, e.session_id) AS session_title,
      COALESCE(ds.agent, 'main')               AS agent
    FROM fact_errors e
    LEFT JOIN dim_sessions ds USING (session_id)
    WHERE 1=1
    ${kindClause}
    ${tsClause}
    ORDER BY e.ts DESC
    LIMIT 500
  `, params)
}
