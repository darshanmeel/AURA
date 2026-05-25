import { query, queryOne } from '../db'

function tsFilter(col: string, since: string | null): string {
  if (!since) return ''
  return `WHERE ${col} >= '${since}'`
}

export async function getPeople(since: string | null = null) {
  // No range filter: lifetime mart is correct (fast path).
  // NOTE: dim_people has no last_seen column, so the previous WHERE clause
  // threw and the page silently showed lifetime data via catch() fallback.
  if (!since) {
    return query(`SELECT * FROM dim_people ORDER BY total_cost DESC`)
  }
  // Range filter: re-aggregate from dim_sessions, joining int_app_cwd_lookup
  // to populate the apps[] / agents[] arrays the page renders as chips.
  return query(`
    SELECT
      ds.person_id                                AS person_id,
      ANY_VALUE(ds.person_name)                   AS person_name,
      COUNT(DISTINCT ds.session_id)               AS session_count,
      COUNT(DISTINCT al.app_id)                   AS app_count,
      ARRAY_AGG(DISTINCT ds.agent)
        FILTER (WHERE ds.agent IS NOT NULL)        AS agents,
      ARRAY_AGG(DISTINCT al.app_id)
        FILTER (WHERE al.app_id IS NOT NULL)       AS apps,
      SUM(ds.total_cost)                          AS total_cost,
      SUM(ds.turn_count)                          AS total_turns,
      SUM(ds.commits)                             AS total_commits
    FROM dim_sessions ds
    LEFT JOIN int_app_cwd_lookup al ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id
    WHERE ds.start_ts >= '${since}'
      AND ds.person_id IS NOT NULL
    GROUP BY ds.person_id
    ORDER BY total_cost DESC NULLS LAST
  `)
}

export async function getPerson(personId: string) {
  return queryOne(`SELECT * FROM dim_people WHERE person_id = ?`, [personId])
}

export async function getPersonSessions(personId: string, since: string | null = null) {
  const sinceClause = since ? ` AND start_ts >= '${since}'` : ''
  return query(`
    SELECT session_id, start_ts, end_ts, cwd, agent, session_title,
           status, turn_count, total_cost, commits
    FROM dim_sessions WHERE person_id = ?${sinceClause} ORDER BY start_ts DESC LIMIT 20
  `, [personId])
}

export async function getPersonAgents(personId: string, since: string | null = null) {
  const sinceClause = since ? ` AND ds.start_ts >= '${since}'` : ''
  return query(`
    SELECT ds.agent,
           COUNT(DISTINCT ds.session_id) AS session_count,
           SUM(ds.turn_count)            AS total_turns,
           SUM(ds.total_cost)            AS total_cost
    FROM dim_sessions ds
    WHERE ds.person_id = ?
      AND ds.agent IS NOT NULL${sinceClause}
    GROUP BY ds.agent
    ORDER BY total_cost DESC
  `, [personId])
}

export async function getPersonApps(personId: string, since: string | null = null) {
  const sinceClause = since ? ` AND ds.start_ts >= '${since}'` : ''
  return query(`
    SELECT da.app_id,
           COALESCE(da.app_name, da.app_id) AS app_name,
           COUNT(DISTINCT ds.session_id)    AS session_count,
           SUM(ds.turn_count)               AS total_turns,
           SUM(ds.total_cost)               AS total_cost
    FROM dim_sessions ds
    INNER JOIN dim_apps da ON da.cwd = ds.cwd
    WHERE ds.person_id = ?
      AND da.app_id IS NOT NULL${sinceClause}
    GROUP BY da.app_id, da.app_name
    ORDER BY total_cost DESC
  `, [personId])
}

export async function getPersonPrompts(personId: string, limit = 8, since: string | null = null) {
  const sinceClause = since ? ` AND ds.start_ts >= '${since}'` : ''
  return query(`
    SELECT fp.prompt_ts, fp.prompt_text_200, fp.agent, fp.app_id,
           fp.turn_count, fp.tool_call_count, fp.files_edited, fp.cost_total
    FROM fact_prompts fp
    JOIN dim_sessions ds USING (session_id)
    WHERE ds.person_id = ?${sinceClause}
    ORDER BY fp.prompt_ts DESC
    LIMIT ?
  `, [personId, limit])
}

/**
 * Range-aware aggregates for the person header KPIs. When `since` is null we
 * return null so the page falls back to the lifetime mart (`dim_people`).
 * When set, we re-aggregate from dim_sessions in the same shape dim_people
 * exposes, so the detail page can swap them in-place.
 */
export async function getPersonRangeAggregates(personId: string, since: string | null) {
  if (!since) return null
  return queryOne(`
    SELECT
      COUNT(DISTINCT ds.session_id)                   AS session_count,
      SUM(ds.turn_count)                              AS total_turns,
      SUM(ds.total_cost)                              AS total_cost,
      SUM(ds.total_output_tokens)                     AS total_output_tokens,
      SUM(ds.commits)                                 AS total_commits
    FROM dim_sessions ds
    WHERE ds.person_id = ?
      AND ds.start_ts >= '${since}'
  `, [personId])
}
